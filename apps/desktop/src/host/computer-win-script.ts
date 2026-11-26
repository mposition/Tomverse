/**
 * The Windows side of the computer tools: one long-lived Windows PowerShell process that compiles a small C# class (P/Invoke into
 * user32 and dwmapi, no native module to build) and answers one JSON request per line on stdin with one JSON line on stdout.
 *
 * It lists top-level windows, reads one window's state, captures ONE window with PrintWindow (so another window in front of it never
 * ends up in the picture) and sends mouse and keyboard input with SendInput. Every input operation re-checks, inside the same call
 * and right before the input is sent, that the window is still the same one, is not minimized, is the foreground window, and (for a
 * point) that the pointer is on the target and the window itself is what sits under it; a double click checks again before its
 * second click, and a scroll before each wheel input. The host ends this process when the person stops the agent. The C# is C# 5: that is what Windows PowerShell 5.1 compiles.
 *
 * The text is ASCII: non-ASCII characters travel as \uXXXX escapes in both directions, so no console code page can change them.
 */
export const WINDOWS_COMPUTER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class Cu {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  delegate bool EnumProc(IntPtr h, IntPtr lp);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);

  static JavaScriptSerializer js = new JavaScriptSerializer();

  public static void Init() {
    js.MaxJsonLength = int.MaxValue;
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } }
  }

  static string TextOf(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, s.Capacity); return s.ToString(); }
  static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, s.Capacity); return s.ToString(); }
  static uint PidOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  static string AppOf(uint pid) { try { return Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { return ""; } }
  static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
  static RECT Frame(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, 16) == 0) return r;
    GetWindowRect(h, out r);
    return r;
  }
  static string Hex(IntPtr h) { return h.ToInt64().ToString("x"); }

  static bool Candidate(IntPtr h) {
    if (!IsWindowVisible(h) || Cloaked(h)) return false;
    if (GetWindow(h, 4) != IntPtr.Zero) return false;
    int ex = GetWindowLong(h, -20);
    if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return false;
    if (TextOf(h).Length == 0) return false;
    RECT f = Frame(h);
    return f.Right - f.Left > 20 && f.Bottom - f.Top > 20;
  }

  static Dictionary<string, object> Describe(IntPtr h) {
    uint pid = PidOf(h);
    var d = new Dictionary<string, object>();
    d["hwnd"] = Hex(h); d["pid"] = (int)pid; d["title"] = TextOf(h); d["cls"] = ClassOf(h); d["app"] = AppOf(pid);
    return d;
  }

  static List<object> List() {
    var rows = new List<object>();
    EnumWindows(delegate (IntPtr h, IntPtr lp) { if (Candidate(h)) rows.Add(Describe(h)); return true; }, IntPtr.Zero);
    return rows;
  }

  static IntPtr Find(Dictionary<string, object> r) {
    IntPtr h = new IntPtr(Convert.ToInt64((string)r["hwnd"], 16));
    if (!IsWindow(h)) return IntPtr.Zero;
    if (PidOf(h) != (uint)Convert.ToInt32(r["pid"])) return IntPtr.Zero;
    if (ClassOf(h) != (string)r["cls"]) return IntPtr.Zero;
    return h;
  }

  static bool IsFront(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    return fg != IntPtr.Zero && GetAncestor(fg, 2) == h;
  }

  static bool Covered(IntPtr h, RECT f) {
    long area = (long)(f.Right - f.Left) * (f.Bottom - f.Top);
    if (area <= 0) return false;
    IntPtr w = h;
    while ((w = GetWindow(w, 3)) != IntPtr.Zero) {
      if (!IsWindowVisible(w) || IsIconic(w) || Cloaked(w)) continue;
      if ((GetWindowLong(w, -20) & 0x20) != 0) continue;
      RECT o = Frame(w);
      int l = Math.Max(f.Left, o.Left), t = Math.Max(f.Top, o.Top), rr = Math.Min(f.Right, o.Right), b = Math.Min(f.Bottom, o.Bottom);
      if (rr <= l || b <= t) continue;
      if ((long)(rr - l) * (b - t) * 20 > area) return true;
    }
    return false;
  }

  static void Status(IntPtr h, Dictionary<string, object> d) {
    RECT f = Frame(h);
    IntPtr fg = GetForegroundWindow();
    bool min = IsIconic(h);
    d["minimized"] = min;
    d["foreground"] = IsFront(h);
    d["fgPid"] = fg == IntPtr.Zero ? 0 : (int)PidOf(fg);
    d["covered"] = !min && Covered(h, f);
    d["w"] = f.Right - f.Left; d["h"] = f.Bottom - f.Top;
    d["title"] = TextOf(h); d["app"] = AppOf(PidOf(h));
  }

  static Dictionary<string, object> Capture(IntPtr h, int maxEdge, Dictionary<string, object> d) {
    Status(h, d);
    if ((bool)d["minimized"]) return d;
    RECT rect; GetWindowRect(h, out rect);
    RECT f = Frame(h);
    int fw = f.Right - f.Left, fh = f.Bottom - f.Top;
    int rw = rect.Right - rect.Left, rh = rect.Bottom - rect.Top;
    if (rw <= 0 || rh <= 0 || fw <= 0 || fh <= 0) throw new Exception("The window has no size.");
    using (var full = new Bitmap(rw, rh, PixelFormat.Format32bppRgb)) {
      using (var g = Graphics.FromImage(full)) {
        IntPtr hdc = g.GetHdc();
        bool ok;
        try { ok = PrintWindow(h, hdc, 2); } finally { g.ReleaseHdc(hdc); }
        if (!ok) throw new Exception("The window could not be captured.");
      }
      int cx = Math.Max(0, f.Left - rect.Left), cy = Math.Max(0, f.Top - rect.Top);
      int cw = Math.Min(fw, rw - cx), ch = Math.Min(fh, rh - cy);
      int outW = cw, outH = ch;
      int edge = Math.Max(cw, ch);
      if (edge > maxEdge) { outW = Math.Max(1, (int)((long)cw * maxEdge / edge)); outH = Math.Max(1, (int)((long)ch * maxEdge / edge)); }
      using (var small = new Bitmap(outW, outH, PixelFormat.Format24bppRgb)) {
        using (var g = Graphics.FromImage(small)) {
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.DrawImage(full, new Rectangle(0, 0, outW, outH), new Rectangle(cx, cy, cw, ch), GraphicsUnit.Pixel);
        }
        d["imageW"] = outW; d["imageH"] = outH; d["physW"] = cw; d["physH"] = ch;
        string mime = "image/png";
        byte[] bytes;
        using (var ms = new MemoryStream()) { small.Save(ms, ImageFormat.Png); bytes = ms.ToArray(); }
        if (bytes.Length > 2900000) {
          mime = "image/jpeg";
          ImageCodecInfo codec = null;
          foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
          var p = new EncoderParameters(1);
          p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 75L);
          using (var ms = new MemoryStream()) { small.Save(ms, codec, p); bytes = ms.ToArray(); }
        }
        d["mediaType"] = mime; d["base64"] = Convert.ToBase64String(bytes);
      }
    }
    return d;
  }

  // ── input ──
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i;
  }
  static INPUT Mouse(uint flags, uint data) {
    var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i;
  }
  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != (uint)inputs.Length) throw new Exception("The input was not accepted by Windows.");
  }
  static bool IsExtended(int vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E; }

  static string Check(IntPtr h, Dictionary<string, object> r) {
    if (h == IntPtr.Zero) return "gone";
    if (IsIconic(h)) return "minimized";
    RECT f = Frame(h);
    if (Math.Abs((f.Right - f.Left) - Convert.ToInt32(r["w"])) > 1 || Math.Abs((f.Bottom - f.Top) - Convert.ToInt32(r["h"])) > 1) return "resized";
    if (!IsFront(h)) return "not-front";
    if (Covered(h, f)) return "covered";
    return null;
  }

  static void Activate(IntPtr h) {
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
  }

  static string AtPoint(IntPtr h, RECT f, int px, int py) {
    if (px < f.Left || py < f.Top || px >= f.Right || py >= f.Bottom) return "outside";
    var p = new POINT(); p.X = px; p.Y = py;
    IntPtr top = WindowFromPoint(p);
    if (top == IntPtr.Zero || GetAncestor(top, 2) != h) return "covered-point";
    return null;
  }

  // The last look before a mouse input: the window is still the same, in front and in the same place, the pointer is where it was
  // put, and the window itself is under it. The pointer can be moved by the person or by another program after it was set.
  static string PointCheck(IntPtr h, Dictionary<string, object> r, RECT origin, int px, int py) {
    if (Find(r) != h) return "gone";
    string why = Check(h, r);
    if (why != null) return why;
    RECT f = Frame(h);
    if (Math.Abs(f.Left - origin.Left) > 1 || Math.Abs(f.Top - origin.Top) > 1) return "moved";
    POINT c;
    if (!GetCursorPos(out c) || Math.Abs(c.X - px) > 1 || Math.Abs(c.Y - py) > 1) return "cursor-moved";
    return AtPoint(h, f, px, py);
  }

  static int IdleMs() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)); GetLastInputInfo(ref i); return (int)((uint)Environment.TickCount - i.dwTime); }

  static Dictionary<string, object> Act(Dictionary<string, object> r) {
    var d = new Dictionary<string, object>();
    IntPtr h = Find(r);
    string why = Check(h, r);
    int allow = r.ContainsKey("allowPid") ? Convert.ToInt32(r["allowPid"]) : 0;
    if (why == "not-front" && allow > 0 && IsIconic(h) == false) {
      IntPtr fg = GetForegroundWindow();
      if (fg != IntPtr.Zero && PidOf(fg) == (uint)allow) {
        Activate(h);
        for (int i = 0; i < 8 && !IsFront(h); i++) Thread.Sleep(60);
        why = Check(h, r);
      }
    }
    if (why != null) { d["performed"] = false; d["reason"] = why; return d; }
    RECT f = Frame(h);
    string kind = (string)r["kind"];
    if (kind == "click" || kind == "scroll") {
      int px = f.Left + Convert.ToInt32(r["x"]), py = f.Top + Convert.ToInt32(r["y"]);
      why = AtPoint(h, f, px, py);
      if (why == null && !IsFront(h)) why = "not-front";
      if (why != null) { d["performed"] = false; d["reason"] = why; return d; }
      if (!SetCursorPos(px, py)) { d["performed"] = false; d["reason"] = "cursor-failed"; return d; }
      Thread.Sleep(20);
      if (kind == "click") {
        bool right = (string)r["button"] == "right";
        uint down = right ? 0x8u : 0x2u, up = right ? 0x10u : 0x4u;
        int times = (bool)r["double"] ? 2 : 1;
        for (int i = 0; i < times; i++) {
          why = PointCheck(h, r, f, px, py);
          if (why != null) { d["performed"] = false; d["reason"] = why; return d; }
          Send(Mouse(down, 0), Mouse(up, 0));
          if (i + 1 < times) Thread.Sleep(60);
        }
      } else {
        int dx = Convert.ToInt32(r["dx"]), dy = Convert.ToInt32(r["dy"]);
        if (dy != 0) {
          why = PointCheck(h, r, f, px, py);
          if (why != null) { d["performed"] = false; d["reason"] = why; return d; }
          Send(Mouse(0x800, unchecked((uint)(-dy * 120))));
        }
        if (dx != 0) {
          why = PointCheck(h, r, f, px, py);
          if (why != null) { d["performed"] = false; d["reason"] = why; return d; }
          Send(Mouse(0x1000, unchecked((uint)(dx * 120))));
        }
      }
      d["performed"] = true;
    } else if (kind == "key") {
      bool ctrl = (bool)r["ctrl"], shift = (bool)r["shift"];
      int vk = Convert.ToInt32(r["vk"]);
      var list = new List<INPUT>();
      if (ctrl) list.Add(Key(0x11, 0, 0));
      if (shift) list.Add(Key(0x10, 0, 0));
      uint ext = IsExtended(vk) ? 1u : 0u;
      list.Add(Key((ushort)vk, 0, ext)); list.Add(Key((ushort)vk, 0, ext | 2u));
      if (shift) list.Add(Key(0x10, 0, 2));
      if (ctrl) list.Add(Key(0x11, 0, 2));
      Send(list.ToArray());
      d["performed"] = true;
    } else if (kind == "type") {
      string text = (string)r["text"];
      int sent = 0, inBatch = 0;
      var batch = new List<INPUT>();
      for (int i = 0; i < text.Length; i++) {
        char c = text[i];
        if (c != '\r') {
          if (c == '\n') { batch.Add(Key(0x0D, 0, 0)); batch.Add(Key(0x0D, 0, 2)); }
          else if (c == '\t') { batch.Add(Key(0x09, 0, 0)); batch.Add(Key(0x09, 0, 2)); }
          else { batch.Add(Key(0, c, 4)); batch.Add(Key(0, c, 6)); }
          inBatch++;
        }
        if (inBatch > 0 && (inBatch >= 16 || i == text.Length - 1)) {
          if (!IsFront(h)) { d["performed"] = sent > 0; d["reason"] = "focus-lost"; d["typed"] = sent; return d; }
          Send(batch.ToArray()); batch.Clear(); sent += inBatch; inBatch = 0; Thread.Sleep(5);
        }
      }
      d["performed"] = true; d["typed"] = sent;
    } else throw new Exception("Unknown input kind.");
    d["idleMs"] = IdleMs();
    return d;
  }

  static string Escape(string json) {
    var sb = new StringBuilder(json.Length + 16);
    foreach (char c in json) { if (c > 126) sb.Append("\\u").Append(((int)c).ToString("x4")); else sb.Append(c); }
    return sb.ToString();
  }

  public static string Handle(string line) {
    var res = new Dictionary<string, object>();
    object id = null;
    try {
      var req = (Dictionary<string, object>)js.DeserializeObject(line);
      id = req["id"];
      string op = (string)req["op"];
      if (op == "ping") res["ok"] = true;
      else if (op == "list") { res["ok"] = true; res["windows"] = List(); }
      else if (op == "idle") { res["ok"] = true; res["idleMs"] = IdleMs(); }
      else if (op == "info" || op == "capture") {
        IntPtr h = Find(req);
        res["ok"] = true;
        if (h == IntPtr.Zero) res["gone"] = true;
        else if (op == "info") Status(h, res);
        else Capture(h, Convert.ToInt32(req["maxEdge"]), res);
      }
      else if (op == "front") {
        IntPtr h = Find(req);
        res["ok"] = true;
        if (h == IntPtr.Zero) res["gone"] = true;
        else { if (IsIconic(h)) ShowWindow(h, 9); Activate(h); for (int i = 0; i < 8 && !IsFront(h); i++) Thread.Sleep(60); res["foreground"] = IsFront(h); }
      }
      else if (op == "act") { res["ok"] = true; foreach (var kv in Act(req)) res[kv.Key] = kv.Value; }
      else throw new Exception("Unknown operation.");
    } catch (Exception e) { res.Clear(); res["ok"] = false; res["error"] = e.GetType().Name + ": " + e.Message; }
    res["id"] = id;
    return Escape(js.Serialize(res));
  }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Drawing','System.Web.Extensions'
[Cu]::Init()
$stdin = [Console]::OpenStandardInput()
$reader = New-Object System.IO.StreamReader($stdin, (New-Object System.Text.UTF8Encoding($false)))
$stdout = [Console]::OpenStandardOutput()
$writer = New-Object System.IO.StreamWriter($stdout, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true
$writer.WriteLine('{"ready":true}')
while ($null -ne ($line = $reader.ReadLine())) {
  if ($line.Length -eq 0) { continue }
  $writer.WriteLine([Cu]::Handle($line))
}
`;
