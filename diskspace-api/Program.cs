using System.Buffers;
using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using DiskSpaceApi.Logic;

namespace DiskSpaceApiService;

// ============================================================================
//  DiskSpaceApi — Windows Service
//  Exposes: GET /disk (and GET /)  ->  { "ip": "...", "C_free_gb": n, "D_free_gb": n }
//  Port: 9988. No polling. Disk is queried only when a request arrives.
// ============================================================================

#if WINDOWS
using Microsoft.Extensions.Hosting.WindowsServices;
#endif

/// <summary>
/// Program entry point. On Windows the service name is registered so that
/// sc.exe start/stop and the SCM see "DiskSpaceApi"; running interactively
/// (console) still works for debugging.
/// </summary>
public static partial class Program
{
    public static async Task Main(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);

        // The default content root is Environment.CurrentDirectory, which for a
        // Windows Service is C:\Windows\System32 — not where we install
        // appsettings.json. Pin it to the directory holding the executable so
        // config and logs resolve correctly whether we run as a service, from a
        // console, or from a test harness.
        builder.Environment.ContentRootPath = AppContext.BaseDirectory;

        // CreateApplicationBuilder captured its content root before the line
        // above, so its own appsettings.json lookup would still use the wrong
        // directory. Add the file explicitly from the executable's directory.
        builder.Configuration.AddJsonFile(
            Path.Combine(AppContext.BaseDirectory, "appsettings.json"),
            optional: true,
            reloadOnChange: true);

        // Windows Service integration (SERVICE_NAME / start-stop events, no console needed).
#if WINDOWS
        builder.Services.AddWindowsService(options => options.ServiceName = "DiskSpaceApi");
#endif
        builder.Services.Configure<DiskSpaceApiOptions>(builder.Configuration.GetSection("DiskSpaceApi"));
        builder.Services.AddSingleton<ApiRequestLogger>();
        builder.Services.AddHostedService<DiskSpaceApiWorker>();

        // Console logging is only useful when running interactively (debugging).
        builder.Logging.AddConfiguration(builder.Configuration.GetSection("Logging"));

        using var host = builder.Build();
        await host.RunAsync();
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

public sealed class DiskSpaceApiOptions
{
    public int Port { get; set; } = 9988;

    // NOTE: configuration binding *appends* to an existing List<T> instead of
    // replacing it, so these must start empty or the defaults end up merged with
    // whatever appsettings.json says (we would then bind both :9988 and the
    // configured port). Fallbacks live in EffectivePrefixes / EffectiveDrives.
    public List<string> Prefixes { get; set; } = new();

    public List<string> Drives { get; set; } = new();

    /// <summary>Network prefix the workstation IP must belong to, e.g. 10.139.0.0.</summary>
    public string Subnet { get; set; } = "10.139.0.0";

    public int SubnetPrefixLength { get; set; } = 16;

    public string LogDirectory { get; set; } = @"C:\ProgramData\DiskSpaceApi\logs";

    public long MaxLogFileBytes { get; set; } = 5 * 1024 * 1024;

    public int MaxLogFiles { get; set; } = 5;

    /// <summary>Per-request budget (ms) used for HTTP.sys header-wait / idle-connection timeouts.</summary>
    public int RequestTimeoutMs { get; set; } = 10_000;

    /// <summary>Bounded in-flight request concurrency; excess requests wait (no unbounded task creation).</summary>
    public int MaxConcurrentRequests { get; set; } = 64;

    /// <summary>Upper bound on queued log records; prevents unbounded memory growth if the disk stalls.</summary>
    public int MaxQueuedLogRecords { get; set; } = 10_000;
}

// ---------------------------------------------------------------------------
// Worker / hosted service lifecycle
// ---------------------------------------------------------------------------

public sealed class DiskSpaceApiWorker : BackgroundService
{
    private readonly IHostApplicationLifetime _lifetime;
    private readonly IOptions<DiskSpaceApiOptions> _options;
    private readonly ApiRequestLogger _log;
    private readonly ILogger<DiskSpaceApiWorker> _logger;
    private readonly HttpApiServer _server;

    public DiskSpaceApiWorker(
        IHostApplicationLifetime lifetime,
        IOptions<DiskSpaceApiOptions> options,
        ApiRequestLogger log,
        ILogger<DiskSpaceApiWorker> logger)
    {
        _lifetime = lifetime;
        _options = options;
        _log = log;
        _logger = logger;
        _server = new HttpApiServer(_options.Value, _log, logger);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await _server.RunAsync(stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown path.
        }
        catch (Exception ex)
        {
            // Never let an unhandled exception take the host down silently.
            _log.Error("Fatal server error", ex);
            _logger.LogError(ex, "Fatal server error");
            _lifetime.StopApplication();
        }
    }

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        _log.Info("Service stopping");
        return base.StopAsync(cancellationToken);
    }
}

// ---------------------------------------------------------------------------
// HTTP layer (HttpListener).  On-request disk queries, no polling.
// ---------------------------------------------------------------------------

public sealed class HttpApiServer
{
    private readonly DiskSpaceApiOptions _options;
    private readonly ApiRequestLogger _log;
    private readonly ILogger _logger;
    private readonly SemaphoreSlim _concurrency;

    private HttpListener? _listener;
    private Task? _acceptLoop;

    public HttpApiServer(DiskSpaceApiOptions options, ApiRequestLogger log, ILogger logger)
    {
        _options = options;
        _log = log;
        _logger = logger;
        _concurrency = new SemaphoreSlim(Math.Max(1, options.MaxConcurrentRequests));
    }

    public async Task RunAsync(CancellationToken stoppingToken)
    {
        var prefixes = ResolvePrefixes();

        _listener = new HttpListener
        {
            IgnoreWriteExceptions = true
        };

        foreach (var prefix in prefixes)
        {
            _listener.Prefixes.Add(prefix);
        }

        // Safety nets so a slow / half-open client can never hang a request slot forever.
        // TimeoutManager is Windows-only (HTTP.sys), so guard it.
        ApplyListenerTimeouts();

        _listener.Start();
        _acceptLoop = Task.Run(() => AcceptLoopAsync(stoppingToken), CancellationToken.None);

        _log.Info($"Service started; listening on {string.Join(", ", prefixes)}");
        _logger.LogInformation("Service started; listening on {Prefixes}", string.Join(", ", prefixes));

        // Keep this method alive until shutdown is requested.
        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // expected during shutdown
        }
        finally
        {
            await ShutdownAsync();
        }
    }

    private void ApplyListenerTimeouts()
    {
        if (_options.RequestTimeoutMs <= 0 || _listener is not { } listener)
        {
            return;
        }

        var t = _options.RequestTimeoutMs;
        try
        {
            // HeaderWait / IdleConnection bound how long a slow client can hold a slot.
            if (listener.TimeoutManager is { } tm)
            {
                tm.HeaderWait = TimeSpan.FromMilliseconds(t);
                tm.IdleConnection = TimeSpan.FromMilliseconds(t);
                tm.DrainEntityBody = TimeSpan.FromSeconds(2);
                tm.EntityBody = TimeSpan.FromSeconds(5);
            }
        }
        catch (PlatformNotSupportedException)
        {
            // Non-Windows: HTTP.sys timeouts unavailable. The per-request
            // CancellationTokenSource in HandleRequestAsync still bounds work.
        }

#if WINDOWS
        // RequestQueue bounds how long the kernel-side accept queue will hold
        // pending connections before dropping them (Windows only).
        if (listener.TimeoutManager is { } winTm)
        {
            winTm.RequestQueue = TimeSpan.FromSeconds(60);
        }
#endif
    }

    private List<string> ResolvePrefixes()
    {
        var configured = _options.Prefixes
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Select(p => p.Trim())
            .ToList();

        if (configured.Count > 0)
        {
            return configured;
        }

        return new List<string> { $"http://+:{_options.Port}/" };
    }

    private List<string> ResolveDrives() =>
        _options.Drives
            .Where(d => !string.IsNullOrWhiteSpace(d))
            .Select(d => d.Trim().TrimEnd(':', '\\', '/').ToUpperInvariant())
            .ToList() is { Count: > 0 } drives
            ? drives
            : new List<string> { "C", "D" };

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        var listener = _listener!;
        while (!ct.IsCancellationRequested && listener.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync();
            }
            catch (HttpListenerException)
            {
                break; // listener stopped
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (InvalidOperationException)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Error("Error accepting connection", ex);
                continue;
            }

            // Bounded concurrency: no unbounded task creation under load.
            await _concurrency.WaitAsync(ct);
            _ = Task.Run(async () =>
            {
                try
                {
                    await HandleRequestAsync(context);
                }
                catch (Exception ex)
                {
                    _log.Error("Unhandled request error", ex);
                    SafeClose(context);
                }
                finally
                {
                    _concurrency.Release();
                }
            }, CancellationToken.None);
        }
    }

    private async Task HandleRequestAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;
        var clientIp = GetClientIp(request);

        var method = request.HttpMethod?.ToUpperInvariant() ?? "";
        var rawUrl = request.RawUrl ?? "/";
        var path = NormalizePath(rawUrl);

        using var requestCts = new CancellationTokenSource(TimeSpan.FromMilliseconds(
            _options.RequestTimeoutMs > 0 ? _options.RequestTimeoutMs : 10_000));

        int status = 500;
        string payload = """{"error":"Internal server error"}""";

        try
        {
            // Only GET/HEAD are supported.
            if (method != "GET" && method != "HEAD")
            {
                status = 405;
                payload = """{"error":"Method not allowed"}""";
            }
            else if (path is "/disk" or "/")
            {
                // Disk is queried here — only when a valid request arrives.
                status = 200;
                payload = BuildDiskJson();
            }
            else
            {
                status = 404;
                payload = """{"error":"Not found"}""";
            }

            await WriteResponseAsync(response, status, payload, method, requestCts.Token);
        }
        catch (Exception ex)
        {
            _log.Error($"Error handling request {method} {rawUrl}", ex);
            status = 500;
            payload = """{"error":"Internal server error"}""";
            try
            {
                await WriteResponseAsync(response, status, payload, method, CancellationToken.None);
            }
            catch
            {
                // Client already gone; nothing useful left to do.
            }
        }
        finally
        {
            SafeClose(context);
            _log.Request(clientIp, method, path, status, payload);
        }
    }

    private string NormalizePath(string rawUrl)
    {
        var path = rawUrl;
        var q = path.IndexOf('?');
        if (q >= 0)
        {
            path = path[..q];
        }

        if (path.Length == 0)
        {
            path = "/";
        }

        // Collapse trailing slashes so "/disk/" behaves like "/disk".
        while (path.Length > 1 && path.EndsWith('/'))
        {
            path = path[..^1];
        }

        return path;
    }

    private static async Task WriteResponseAsync(
        HttpListenerResponse response, int status, string payload, string method, CancellationToken ct)
    {
        var body = Encoding.UTF8.GetBytes(payload);

        response.StatusCode = status;
        response.ContentType = "application/json; charset=utf-8";
        response.ContentLength64 = body.Length; // exact Content-Length
        response.SendChunked = false;
        response.KeepAlive = false;               // Connection: close
        response.Headers["Cache-Control"] = "no-store";

        // HEAD: headers only, no body (Content-Length still correct).
        if (method.Equals("HEAD", StringComparison.OrdinalIgnoreCase))
        {
            response.OutputStream.Close();
            return;
        }

        await response.OutputStream.WriteAsync(body, ct);
        await response.OutputStream.FlushAsync(ct);
    }

    // -----------------------------------------------------------------------
    // Payload construction
    // -----------------------------------------------------------------------

    private string BuildDiskJson()
    {
        var ip = WorkstationInfo.GetPreferredIpv4(_options.Subnet, _options.SubnetPrefixLength);

        var model = new DiskPayload
        {
            Ip = ip ?? "Unknown"
        };

        foreach (var drive in ResolveDrives())
        {
            model.SetDrive(drive, WorkstationInfo.GetFreeSpaceGb(drive));
        }

        return JsonSerializer.Serialize(model, DiskPayloadJsonContext.Default.DiskPayload);
    }

    private static void SafeClose(HttpListenerContext context)
    {
        try
        {
            context.Response.OutputStream.Close();
        }
        catch
        {
            // ignore
        }

        try
        {
            context.Response.Close();
        }
        catch
        {
            // ignore
        }
    }

    private static string GetClientIp(HttpListenerRequest request)
    {
        try
        {
            return request.RemoteEndPoint?.Address?.ToString() ?? "unknown";
        }
        catch
        {
            return "unknown";
        }
    }

    private async Task ShutdownAsync()
    {
        var listener = _listener;
        if (listener is null)
        {
            return;
        }

        try
        {
            if (listener.IsListening)
            {
                listener.Stop();   // releases port 9988
            }

            listener.Close();
        }
        catch (Exception ex)
        {
            _log.Error("Error during listener shutdown", ex);
        }

        try
        {
            if (_acceptLoop is not null)
            {
                await _acceptLoop.WaitAsync(TimeSpan.FromSeconds(5));
            }
        }
        catch
        {
            // ignore
        }

        _log.Info("Service stopped; port released");
        _logger.LogInformation("Service stopped; port released");
    }
}

// ---------------------------------------------------------------------------
// Logging: rotating file at %ProgramData%\DiskSpaceApi\logs\service.log
// Bounded queue + background writer, so a slow disk never blocks a request.
// ---------------------------------------------------------------------------

public sealed class ApiRequestLogger : IAsyncDisposable
{
    private static readonly Encoding Utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

    private sealed record LogRecord(DateTime Timestamp, string Level, string Message, string? Exception);

    private readonly ConcurrentQueue<LogRecord> _queue = new();
    private readonly SemaphoreSlim _signal = new(0);
    private readonly DiskSpaceApiOptions _options;
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _writerTask;
    private readonly object _fileLock = new();
    private readonly string _logPath;
    private int _dropped;

    public ApiRequestLogger(IOptions<DiskSpaceApiOptions> options)
    {
        _options = options.Value;
        _logPath = Path.Combine(_options.LogDirectory, "service.log");

        try
        {
            Directory.CreateDirectory(_options.LogDirectory);
        }
        catch
        {
            // If we cannot create the log dir we still keep serving;
            // records will simply be dropped rather than crashing the service.
        }

        _writerTask = Task.Run(WriterLoopAsync);
    }

    public string LogPath => _logPath;

    public void Info(string message) => Enqueue("INFO", message, null);

    public void Error(string message, Exception? ex) => Enqueue("ERROR", message, ex);

    public void Request(string clientIp, string method, string path, int status, string payload)
    {
        var trimmed = Truncate(payload, 512);
        Enqueue("REQ", $"client={clientIp} {method} {path} status={status} body={trimmed}", null);
    }

    private void Enqueue(string level, string message, Exception? ex)
    {
        if (_queue.Count >= _options.MaxQueuedLogRecords)
        {
            Interlocked.Increment(ref _dropped);
            return;
        }

        _queue.Enqueue(new LogRecord(DateTime.Now, level, message, ex?.ToString()));

        try
        {
            _signal.Release();
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private async Task WriterLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            try
            {
                await _signal.WaitAsync(TimeSpan.FromSeconds(2), _cts.Token);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }

            Drain();
        }

        Drain();
    }

    private void Drain()
    {
        while (_queue.TryDequeue(out var record))
        {
            try
            {
                WriteRecord(record);
            }
            catch
            {
                // never let logging kill the service
                return;
            }
        }
    }

    private void WriteRecord(LogRecord record)
    {
        var dropped = Interlocked.Exchange(ref _dropped, 0);
        var sb = new StringBuilder();
        sb.Append('[')
          .Append(record.Timestamp.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture))
          .Append("] [")
          .Append(record.Level)
          .Append("] ")
          .Append(record.Message);

        if (!string.IsNullOrEmpty(record.Exception))
        {
            sb.Append(" | exception=").Append(record.Exception.Replace("\r", " ").Replace('\n', ' '));
        }

        if (dropped > 0)
        {
            sb.Append(" | dropped=").Append(dropped);
        }

        sb.Append('\n');

        var text = sb.ToString();

        lock (_fileLock)
        {
            try
            {
                Directory.CreateDirectory(_options.LogDirectory);
                // UTF-8 *without* BOM — a BOM would corrupt the first line for
                // log parsers and for the first line of a rotated file.
                File.AppendAllText(_logPath, text, Utf8NoBom);
                RotateIfNeeded();
            }
            catch
            {
                // ignore logging failures
            }
        }
    }

    private void RotateIfNeeded()
    {
        try
        {
            var info = new FileInfo(_logPath);
            if (!info.Exists || info.Length < _options.MaxLogFileBytes)
            {
                return;
            }

            var dir = info.DirectoryName!;
            var baseName = Path.GetFileNameWithoutExtension(_logPath);
            var ext = info.Extension;

            for (int i = _options.MaxLogFiles - 1; i >= 1; i--)
            {
                var from = Path.Combine(dir, $"{baseName}.{i}{ext}");
                var to = Path.Combine(dir, $"{baseName}.{i + 1}{ext}");
                if (File.Exists(from))
                {
                    if (i == _options.MaxLogFiles - 1)
                    {
                        File.Delete(from);
                    }
                    else
                    {
                        File.Move(from, to, overwrite: true);
                    }
                }
            }

            File.Move(_logPath, Path.Combine(dir, $"{baseName}.1{ext}"), overwrite: true);
        }
        catch
        {
            // ignore rotation failures
        }
    }

    private static string Truncate(string value, int max)
        => value.Length <= max ? value : value[..max] + "…";

    public async ValueTask DisposeAsync()
    {
        try
        {
            _cts.Cancel();
        }
        catch
        {
        }

        try
        {
            await _writerTask.WaitAsync(TimeSpan.FromSeconds(3));
        }
        catch
        {
        }

        _signal.Dispose();
        _cts.Dispose();
    }
}
