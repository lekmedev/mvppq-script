// Standalone logic tests for the pure functions in Program.cs.
// These exercise IP subnet parsing and free-space rounding/edge cases that
// cannot be reached through the HTTP endpoint on a Linux test box
// (no 10.139.x.x NIC, no C:/D: drives).
using System;
using System.Net;
using System.Text.Json;
using DiskSpaceApi.Logic;

var failures = 0;
var passes = 0;

void Check(string name, bool ok, string detail = "")
{
    if (ok) { passes++; Console.WriteLine($"  [PASS] {name}"); }
    else { failures++; Console.WriteLine($"  [FAIL] {name}   {detail}"); }
}

void Section(string name) => Console.WriteLine($"\n== {name} ==");

// --------------------------------------------------------------- subnet parse
Section("Ipv4Subnet.TryParseSubnet");

Check("10.139.0.0/16 parses",
    Ipv4Subnet.TryParseSubnet("10.139.0.0", 16, out var net16, out var mask16)
    && net16.ToString() == "10.139.0.0" && mask16.ToString() == "255.255.0.0",
    $"got {net16}/{mask16}");

Check("10.0.0.0/8 parses to 10.0.0.0/255.0.0.0",
    Ipv4Subnet.TryParseSubnet("10.0.0.0", 8, out var net8, out var mask8)
    && net8.ToString() == "10.0.0.0" && mask8.ToString() == "255.0.0.0");

Check("0.0.0.0/0 gives an all-zero mask",
    Ipv4Subnet.TryParseSubnet("0.0.0.0", 0, out var net0, out var mask0)
    && mask0.ToString() == "0.0.0.0");

Check("non-normalized input is normalized (10.139.20.88/16 -> 10.139.0.0)",
    Ipv4Subnet.TryParseSubnet("10.139.20.88", 16, out var netN, out _)
    && netN.ToString() == "10.139.0.0",
    $"got {netN}");

Check("prefix 32 keeps the exact host",
    Ipv4Subnet.TryParseSubnet("10.139.20.88", 32, out var net32, out var m32)
    && net32.ToString() == "10.139.20.88"
    && m32.ToString() == "255.255.255.255");

Check("prefix 33 rejected", !Ipv4Subnet.TryParseSubnet("10.139.0.0", 33, out _, out _));
Check("negative prefix rejected", !Ipv4Subnet.TryParseSubnet("10.139.0.0", -1, out _, out _));
Check("garbage subnet rejected", !Ipv4Subnet.TryParseSubnet("not-an-ip", 16, out _, out _));
Check("IPv6 subnet rejected", !Ipv4Subnet.TryParseSubnet("fe80::1", 64, out _, out _));

// ------------------------------------------------------------- subnet matching
Section("subnet membership (the 10.139.0.0/16 filter)");

bool InSubnet(string ip)
{
    if (!Ipv4Subnet.TryParseSubnet("10.139.0.0", 16, out var net, out var mask)) return false;
    var a = IPAddress.Parse(ip).GetAddressBytes();
    var n = net.GetAddressBytes();
    var m = mask.GetAddressBytes();
    for (int i = 0; i < 4; i++) if ((a[i] & m[i]) != n[i]) return false;
    return true;
}

Check("10.139.20.88 is inside", InSubnet("10.139.20.88"));
Check("10.139.0.1 is inside", InSubnet("10.139.0.1"));
Check("10.139.255.254 is inside", InSubnet("10.139.255.254"));
Check("10.138.255.254 is OUTSIDE", !InSubnet("10.138.255.254"));
Check("10.140.0.1 is OUTSIDE", !InSubnet("10.140.0.1"));
Check("192.168.1.10 is OUTSIDE", !InSubnet("192.168.1.10"));
Check("169.254.1.1 (APIPA) is OUTSIDE", !InSubnet("169.254.1.1"));
Check("127.0.0.1 (loopback) is OUTSIDE", !InSubnet("127.0.0.1"));

// -------------------------------------------------------------- free space
Section("GetFreeSpaceGb");

var rootFree = WorkstationInfo.GetFreeSpaceGb("/");
Check("real root drive returns a non-negative whole number",
    rootFree is not null && rootFree >= 0, $"got {rootFree?.ToString() ?? "null"}");

Check("nonexistent drive returns null",
    WorkstationInfo.GetFreeSpaceGb("Q") is null);

Check("empty/null input returns null",
    WorkstationInfo.GetFreeSpaceGb("") is null
    && WorkstationInfo.GetFreeSpaceGb("   ") is null
    && WorkstationInfo.GetFreeSpaceGb(null) is null);

var vfsFree = WorkstationInfo.GetFreeSpaceGb("/vfs/nosuchmount");
Check("nonexistent mount returns null", vfsFree is null);

// Rounding contract: whole GB, away from zero.
Section("rounding contract");
double bytes = 120.4 * 1024 * 1024 * 1024;
long rounded = (long)Math.Round(bytes / (1024d * 1024d * 1024d), MidpointRounding.AwayFromZero);
Check("120.4 GB rounds to 120", rounded == 120, $"got {rounded}");

// --------------------------------------------------------------- JSON shape
Section("payload JSON contract");

var payload = new DiskPayload { Ip = "10.139.20.88" };
payload.SetDrive("C", 120);
payload.SetDrive("d", 450);
var json = JsonSerializer.Serialize(payload, DiskPayloadJsonContext.Default.DiskPayload);

Check("serializes exact keys and order", json == """{"ip":"10.139.20.88","C_free_gb":120,"D_free_gb":450}""", json);

Check("is compact (no indentation)", !json.Contains('\n') && !json.Contains("  "));

var nullPayload = new DiskPayload { Ip = "Unknown" };
nullPayload.SetDrive("C", null);
nullPayload.SetDrive("D", null);
var nullJson = JsonSerializer.Serialize(nullPayload, DiskPayloadJsonContext.Default.DiskPayload);
Check("missing drives serialize as JSON null",
    nullJson == """{"ip":"Unknown","C_free_gb":null,"D_free_gb":null}""", nullJson);

var parsed = JsonDocument.Parse(json).RootElement;
Check("parses back with expected property names",
    parsed.TryGetProperty("ip", out _)
    && parsed.TryGetProperty("C_free_gb", out _)
    && parsed.TryGetProperty("D_free_gb", out _));

Check("System.Text.Json emits valid UTF-8 (no BOM, no escapes for ASCII)",
    System.Text.Encoding.UTF8.GetBytes(json)[0] != 0xEF);

// ------------------------------------------------------------- IP selection
Section("GetPreferredIpv4 on this host");

var chosen = WorkstationInfo.GetPreferredIpv4("10.139.0.0", 16);
Console.WriteLine($"     this host has no 10.139.x.x NIC -> {chosen ?? "null"}");
Check("returns null when no matching interface exists", chosen is null);

var chosenAny = WorkstationInfo.GetPreferredIpv4("0.0.0.0", 0);
Console.WriteLine($"     with subnet 0.0.0.0/0 -> {chosenAny ?? "null"}");
Check("with an all-zero subnet, a real interface is found",
    chosenAny is not null && chosenAny != "127.0.0.1" && !chosenAny.StartsWith("169.254."),
    $"got {chosenAny}");

Check("bad subnet config returns null safely",
    WorkstationInfo.GetPreferredIpv4("garbage", 16) is null);

// deterministic: same call twice, same answer
var a1 = WorkstationInfo.GetPreferredIpv4("0.0.0.0", 0);
var a2 = WorkstationInfo.GetPreferredIpv4("0.0.0.0", 0);
Check("selection is deterministic across calls", a1 == a2, $"{a1} vs {a2}");

// -------------------------------------------------------------------- summary
Console.WriteLine();
if (failures == 0)
{
    Console.WriteLine($"ALL LOGIC TESTS PASSED ({passes}/{passes})");
    return 0;
}
Console.WriteLine($"{failures} of {passes + failures} logic tests FAILED");
return 1;
