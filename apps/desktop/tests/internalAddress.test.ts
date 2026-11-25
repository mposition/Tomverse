import assert from "node:assert/strict";
import test from "node:test";
import { isInternalAddress, isIpAddress } from "../src/internal-address";

test("IPv4 loopback, private, link-local, CGNAT, multicast and reserved ranges are internal; public unicast is not", () => {
  for (const address of [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.53.1.1", "169.254.169.254", "169.254.0.1",
    "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.254", "192.0.0.8", "192.0.2.10", "192.88.99.1",
    "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.251", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  ]) assert.equal(isInternalAddress(address), true, address);
  for (const address of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1",
    "169.253.1.1", "192.169.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.254"]) {
    assert.equal(isInternalAddress(address), false, address);
  }
});

test("IPv6 loopback, unspecified, unique-local, link-local, multicast and documentation ranges are internal", () => {
  for (const address of [
    "::", "::1", "0:0:0:0:0:0:0:1", "::7f00:1", "::127.0.0.1", "fc00::1", "fd12:3456:789a::1", "fe80::1", "FE80::abcd:1",
    "fe80::1%eth0", "fec0::1", "ff02::1", "ff05::1:3", "100::1", "2001:db8::1", "2001:2::1", "3fff::1", "3fff:fff::1",
    "5f00::1", "4000::1", "::2", "not-an-address", "", "1:2:3:4:5:6:7:8:9", "1::2::3", "12345::1", "::ffff:999.0.0.1",
  ]) assert.equal(isInternalAddress(address), true, address);
  for (const address of ["2606:2800:21f:cb07:6820:80da:af6b:8b2c", "2001:4860:4860::8888", "2a00:1450:4001:82a::200e",
    "3fff:1000::1", "2001:3::1"]) {
    assert.equal(isInternalAddress(address), false, address);
  }
});

test("IPv4 carried in IPv6 is judged by the IPv4 address: mapped, translated, NAT64 well-known and 6to4", () => {
  // IPv4-mapped, dotted and hex.
  assert.equal(isInternalAddress("::ffff:127.0.0.1"), true);
  assert.equal(isInternalAddress("::ffff:7f00:1"), true);
  assert.equal(isInternalAddress("::ffff:169.254.169.254"), true);
  assert.equal(isInternalAddress("::ffff:a9fe:a9fe"), true);
  assert.equal(isInternalAddress("::ffff:10.0.0.1"), true);
  assert.equal(isInternalAddress("::ffff:93.184.215.14"), false);
  // IPv4-translated (SIIT).
  assert.equal(isInternalAddress("::ffff:0:192.168.0.1"), true);
  assert.equal(isInternalAddress("::ffff:0:8.8.8.8"), false);
  // NAT64 well-known prefix: what DNS64 answers for a public IPv4 host stays public.
  assert.equal(isInternalAddress("64:ff9b::127.0.0.1"), true);
  assert.equal(isInternalAddress("64:ff9b::a9fe:a9fe"), true);
  assert.equal(isInternalAddress("64:ff9b::c0a8:101"), true);
  assert.equal(isInternalAddress("64:ff9b::93.184.215.14"), false);
  assert.equal(isInternalAddress("64:ff9b::808:808"), false);
  // The local-use NAT64 prefix is never global, whatever it carries.
  assert.equal(isInternalAddress("64:ff9b:1::8.8.8.8"), true);
  assert.equal(isInternalAddress("64:ff9b:1:abcd::1"), true);
  // 6to4 carries the IPv4 address in bits 16-47.
  assert.equal(isInternalAddress("2002:7f00:1::1"), true);
  assert.equal(isInternalAddress("2002:a9fe:a9fe::1"), true);
  assert.equal(isInternalAddress("2002:c0a8:101::"), true);
  assert.equal(isInternalAddress("2002:5db8:d70e::1"), false);
  // Teredo is refused outright.
  assert.equal(isInternalAddress("2001:0:4136:e378:8000:63bf:3fff:fdd2"), true);
  assert.equal(isInternalAddress("2001::1"), true);
});

test("an address literal is recognised as one, a name is not", () => {
  for (const value of ["127.0.0.1", "93.184.215.14", "::1", "2001:db8::1", "fe80::1%eth0", "::ffff:127.0.0.1"]) {
    assert.equal(isIpAddress(value), true, value);
  }
  for (const value of ["example.com", "127.0.0.1.nip.io", "localhost", "1.2.3", ""]) assert.equal(isIpAddress(value), false, value);
});
