// ============================================================================
//  Shared, dependency-free logic for DiskSpaceApi.
//
//  Kept in its own file (no Microsoft.Extensions.* dependencies) so the logic
//  tests can compile it directly against a plain net8.0 project, with no need
//  to reference the service host.
// ============================================================================

using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DiskSpaceApi.Logic;

// ---------------------------------------------------------------------------
// Payload model
// ---------------------------------------------------------------------------

public sealed class DiskPayload
{
    [JsonPropertyName("ip")]
    public string? Ip { get; set; }

    [JsonPropertyName("C_free_gb")]
    public long? CFreeGb { get; set; }

    [JsonPropertyName("D_free_gb")]
    public long? DFreeGb { get; set; }

    public void SetDrive(string letter, long? freeGb)
    {
        switch (letter.ToUpperInvariant())
        {
            case "C":
                CFreeGb = freeGb;
                break;
            case "D":
                DFreeGb = freeGb;
                break;
        }
    }
}

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(DiskPayload))]
internal sealed partial class DiskPayloadJsonContext : JsonSerializerContext
{
}

// ---------------------------------------------------------------------------
// Workstation info: IP selection + free disk space
// ---------------------------------------------------------------------------

public static class WorkstationInfo
{
    /// <summary>
    /// Deterministic IPv4 selection.
    /// 1. Interface must be Up (OperationalStatus.Up).
    /// 2. Address family must be InterNetwork (IPv4).
    /// 3. Loopback (127/8), APIPA (169.254/16) and anything outside the target
    ///    subnet are excluded.
    /// 4. Remaining candidates are ordered by (interface speed desc, link speed
    ///    desc, interface name ordinal, numeric IPv4 value) and the first is
    ///    taken — so the same host always returns the same answer.
    /// Returns null when no address matches.
    /// </summary>
    public static string? GetPreferredIpv4(string subnet, int prefixLength)
    {
        if (!Ipv4Subnet.TryParseSubnet(subnet, prefixLength, out var network, out _))
        {
            return null;
        }

        var prefixBytes = network.GetAddressBytes();
        uint prefixHostOrder = ReadUInt32BigEndian(prefixBytes);

        List<UnicastCandidate> candidates;
        try
        {
            candidates = new List<UnicastCandidate>();

            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up)
                {
                    continue;
                }

                bool isLoopback = nic.NetworkInterfaceType is NetworkInterfaceType.Loopback;
                if (isLoopback)
                {
                    continue;
                }

                var props = nic.GetIPProperties();
                uint candidate = 0;
                string? candidateAddress = null;

                foreach (var addr in props.UnicastAddresses)
                {
                    if (addr.Address.AddressFamily != AddressFamily.InterNetwork)
                    {
                        continue;
                    }

                    if (IPAddress.IsLoopback(addr.Address))
                    {
                        continue;
                    }

                    var bytes = addr.Address.GetAddressBytes();
                    uint host = ReadUInt32BigEndian(bytes);

                    if (IsApipa(bytes))
                    {
                        continue;
                    }

                    if ((host & prefixHostOrder) != prefixHostOrder)
                    {
                        continue;
                    }

                    // keep the numerically lowest address of this interface
                    if (candidateAddress is null || host < candidate)
                    {
                        candidate = host;
                        candidateAddress = addr.Address.ToString();
                    }
                }

                if (candidateAddress is not null)
                {
                    candidates.Add(new UnicastCandidate(
                        candidateAddress,
                        candidate,
                        (long)nic.Speed,
                        nic.Name ?? string.Empty,
                        nic.Description ?? string.Empty));
                }
            }
        }
        catch (NetworkInformationException)
        {
            return null;
        }

        if (candidates.Count == 0)
        {
            return null;
        }

        var best = candidates
            .OrderByDescending(c => c.InterfaceSpeed)
            .ThenBy(c => c.InterfaceName, StringComparer.Ordinal)
            .ThenBy(c => c.NumericAddress)
            .First();

        return best.Address;
    }

    /// <summary>Free space in whole GB, or null when the drive is missing / not ready.</summary>
    public static long? GetFreeSpaceGb(string? driveLetter)
    {
        if (string.IsNullOrWhiteSpace(driveLetter))
        {
            return null;
        }

        try
        {
            var root = new DriveInfo(driveLetter);
            if (!root.IsReady)
            {
                return null;
            }

            var free = root.TotalFreeSpace;
            const long bytesPerGb = 1024L * 1024L * 1024L;
            var rounded = (long)Math.Round(free / (double)bytesPerGb, MidpointRounding.AwayFromZero);
            return rounded;
        }
        catch (ArgumentException)
        {
            return null; // no such drive
        }
        catch (IOException)
        {
            return null; // device not ready
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static bool IsApipa(byte[] ipv4)
        => ipv4.Length == 4 && ipv4[0] == 169 && ipv4[1] == 254;

    private static uint ReadUInt32BigEndian(byte[] bytes)
    {
        if (bytes.Length != 4)
        {
            throw new ArgumentException("Expected an IPv4 address (4 bytes).", nameof(bytes));
        }

        return ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];
    }

    private sealed record UnicastCandidate(
        string Address,
        uint NumericAddress,
        long InterfaceSpeed,
        string InterfaceName,
        string InterfaceDescription);
}

/// <summary>
/// Minimal IPv4 network parsing so we do not depend on an external package.
/// </summary>
public static class Ipv4Subnet
{
    public static bool TryParseSubnet(string subnet, int prefixLength, out IPAddress network, out IPAddress mask)
    {
        network = IPAddress.None;
        mask = IPAddress.None;

        if (string.IsNullOrWhiteSpace(subnet) || prefixLength is < 0 or > 32)
        {
            return false;
        }

        if (!IPAddress.TryParse(subnet.Trim(), out var parsed))
        {
            return false;
        }

        if (parsed.AddressFamily != AddressFamily.InterNetwork)
        {
            return false;
        }

        var bytes = parsed.GetAddressBytes();
        uint maskHost = prefixLength == 0 ? 0 : uint.MaxValue << (32 - prefixLength);
        var maskBytes = new[]
        {
            (byte)(maskHost >> 24),
            (byte)(maskHost >> 16),
            (byte)(maskHost >> 8),
            (byte)maskHost
        };

        var networkBytes = new byte[4];
        for (int i = 0; i < 4; i++)
        {
            networkBytes[i] = (byte)(bytes[i] & maskBytes[i]);
        }

        network = new IPAddress(networkBytes);
        mask = new IPAddress(maskBytes);
        return true;
    }
}

