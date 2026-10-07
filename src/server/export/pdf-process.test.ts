import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How the PDF renderer identifies the Chromium process it may end (#2290): by an id the browser reports
 * about itself, so the operating system is asked two things about that id, its parent and its start time.
 * Only a child of this server gets a token, and without a token nothing is killed. Each platform's way of
 * asking runs here with the platform name replaced and `/proc`, `powershell.exe` and `ps` replaced by
 * what they print; nothing in this file starts or signals a real process.
 */

type PdfModule = typeof import("./pdf");

const { launch, readFile, execFile, commands } = vi.hoisted(() => ({
  launch: vi.fn<(options: Record<string, unknown>) => Promise<unknown>>(),
  readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
  execFile: vi.fn<(file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>>(),
  commands: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
}));

vi.mock("playwright-core", () => ({ chromium: { launch } }));
vi.mock("node:fs/promises", () => ({ readFile, default: { readFile } }));
vi.mock("node:child_process", () => {
  // `promisify(execFile)` in pdf.ts resolves with `{ stdout, stderr }`, as Node's own does.
  const callbackStyle = () => {
    throw new Error("only the promisified form is used");
  };
  Object.defineProperty(callbackStyle, promisify.custom, {
    value: (file: string, args: string[], options: Record<string, unknown>) => {
      commands.push({ file, args, options });
      return execFile(file, args, options);
    },
  });
  return { execFile: callbackStyle, default: { execFile: callbackStyle } };
});

const realPlatform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value, configurable: true });

const ME = process.pid;
const CHROMIUM = 31337;

/** A stat line as proc(5) describes it: 52 fields, the command name in brackets. Field 4 is the parent, field 22 the start time. */
const statLine = (pid: number, comm: string, parent: number, start: string) =>
  `${pid} (${comm}) S ${parent} ${pid} ${pid} 0 -1 4194560 12345 0 12 0 150 30 0 0 20 0 25 0 ${start} 1234567890 5000 18446744073709551615 1 1 0 0 0 0 0 4096 65536 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;

/** Ids that name no other process: nothing is read and nothing is run for them. */
const REFUSED = [0, 1, -1, -CHROMIUM, 2.5, Number.NaN, ME];

describe("identifying the Chromium process (#2290)", () => {
  let pdf: PdfModule;

  beforeEach(async () => {
    launch.mockReset();
    readFile.mockReset();
    execFile.mockReset();
    commands.length = 0;
    vi.resetModules();
    pdf = await import("./pdf");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pdf.closePdfBrowser(1);
    setPlatform(realPlatform);
    vi.restoreAllMocks();
  });

  describe("on Linux", () => {
    beforeEach(() => setPlatform("linux"));

    it("gives the start time of a process whose parent is this server, whatever the command name holds", async () => {
      const names = ["chrome", "chromium", "Web Content", "a b c d e f g h i j k l m n o p q r s t u v w", `odd) S ${ME} 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 999`, "((nested))", ") ", "x)y) z", ""];
      for (const comm of names) {
        readFile.mockResolvedValueOnce(statLine(CHROMIUM, comm, ME, "777001"));
        expect(await pdf.osProcess.startToken(CHROMIUM), JSON.stringify(comm)).toBe("777001");
        expect(readFile).toHaveBeenLastCalledWith(`/proc/${CHROMIUM}/stat`, "utf8");
      }
    });

    it("gives nothing for a process with any other parent", async () => {
      // 1: a process whose parent died is handed to process 1. Then this server's own parent (a sibling of
      // the server is not its child), someone else's children, and the id itself.
      for (const parent of [1, process.ppid, 0, ME + 1, ME * 10, CHROMIUM]) {
        readFile.mockResolvedValueOnce(statLine(CHROMIUM, "chrome", parent, "777001"));
        expect(await pdf.osProcess.startToken(CHROMIUM), `parent ${parent}`).toBeUndefined();
      }
      // A command name that spells this server's id where the parent would be does not count either.
      readFile.mockResolvedValueOnce(statLine(CHROMIUM, `x) S ${ME} 1`, 4242, "777001"));
      expect(await pdf.osProcess.startToken(CHROMIUM)).toBeUndefined();
    });

    it("gives nothing when the line cannot be read or is cut short, and reads nothing for an id that names no other process", async () => {
      readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      expect(await pdf.osProcess.startToken(CHROMIUM)).toBeUndefined();
      readFile.mockResolvedValueOnce(`${CHROMIUM} (chrome) S ${ME} ${CHROMIUM}`);
      expect(await pdf.osProcess.startToken(CHROMIUM), "no start time on the line").toBeUndefined();
      readFile.mockResolvedValueOnce("");
      expect(await pdf.osProcess.startToken(CHROMIUM)).toBeUndefined();
      readFile.mockClear();
      for (const pid of REFUSED) expect(await pdf.osProcess.startToken(pid), String(pid)).toBeUndefined();
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  describe("on Windows", () => {
    beforeEach(() => setPlatform("win32"));

    it("asks for parent and creation time in one query that holds nothing but the process id", async () => {
      execFile.mockResolvedValueOnce({ stdout: `${ME} 20261007153744.979923-300\r\n`, stderr: "" });

      expect(await pdf.osProcess.startToken(CHROMIUM)).toBe("20261007153744.979923-300");

      expect(commands).toHaveLength(1);
      expect(commands[0].file).toBe("powershell.exe");
      expect(commands[0].args).toEqual(["-NoProfile", "-NonInteractive", "-Command", `$p = [wmi]"Win32_Process.Handle='${CHROMIUM}'"; '{0} {1}' -f $p.ParentProcessId, $p.CreationDate`]);
      expect(commands[0].options).toMatchObject({ timeout: 10_000 });
    });

    it("gives nothing for another parent, a process that is gone, or an answer it does not understand", async () => {
      const answers = [`${ME + 1} 20261007153744.979923-300`, `${process.ppid} 20261007153744.979923-300`, "1 20261007153744.979923-300", "", " ", `${ME}`, `${ME} `, `x${ME} 20261007153744.979923-300`, `${ME} 2026 10 07`, `${ME}0 20261007153744.979923-300`];
      for (const stdout of answers) {
        execFile.mockResolvedValueOnce({ stdout, stderr: "" });
        expect(await pdf.osProcess.startToken(CHROMIUM), JSON.stringify(stdout)).toBeUndefined();
      }
      execFile.mockRejectedValueOnce(Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" }));
      expect(await pdf.osProcess.startToken(CHROMIUM), "no PowerShell").toBeUndefined();
      commands.length = 0;
      for (const pid of REFUSED) expect(await pdf.osProcess.startToken(pid), String(pid)).toBeUndefined();
      expect(commands, "nothing is run for an id that names no other process").toEqual([]);
    });
  });

  describe("on macOS", () => {
    beforeEach(() => setPlatform("darwin"));

    it("asks ps for parent and start time", async () => {
      execFile.mockResolvedValueOnce({ stdout: `  ${ME} Wed Oct  7 15:20:29 2026\n`, stderr: "" });

      expect(await pdf.osProcess.startToken(CHROMIUM)).toBe("Wed Oct  7 15:20:29 2026");

      expect(commands).toHaveLength(1);
      expect(commands[0].file).toBe("ps");
      expect(commands[0].args).toEqual(["-o", "ppid=,lstart=", "-p", String(CHROMIUM)]);
    });

    it("gives nothing for another parent, a process that is gone, or ps missing", async () => {
      for (const stdout of [`  ${ME + 1} Wed Oct  7 15:20:29 2026\n`, `  ${process.ppid} Wed Oct  7 15:20:29 2026\n`, "    1 Wed Oct  7 15:20:29 2026\n", "", `${ME}\n`, "Wed Oct  7 15:20:29 2026\n"]) {
        execFile.mockResolvedValueOnce({ stdout, stderr: "" });
        expect(await pdf.osProcess.startToken(CHROMIUM), JSON.stringify(stdout)).toBeUndefined();
      }
      execFile.mockRejectedValueOnce(new Error("Command failed: ps"));
      expect(await pdf.osProcess.startToken(CHROMIUM)).toBeUndefined();
    });
  });

  it("gives nothing on a platform it has no way to ask, without reading or running anything", async () => {
    for (const platform of ["freebsd", "openbsd", "sunos", "aix", "android"]) {
      setPlatform(platform);
      expect(await pdf.osProcess.startToken(CHROMIUM), platform).toBeUndefined();
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  describe("a Chromium that will not close (Linux, the real identification, a fake browser)", () => {
    /** A browser whose print and close never finish, and that reports `CHROMIUM` as its process id. */
    const hungBrowser = () => {
      const browser = {
        on: () => browser,
        version: () => "1.2.3.4",
        newBrowserCDPSession: async () => ({
          send: async () => ({ processInfo: [{ type: "GPU", id: 4242, cpuTime: 0 }, { type: "browser", id: CHROMIUM, cpuTime: 0 }] }),
          detach: async () => {},
        }),
        newContext: async () => ({
          route: async () => {},
          newPage: async () => ({ setContent: async () => {}, emulateMedia: async () => {}, pdf: () => new Promise<Uint8Array>(() => {}) }),
          close: async () => {},
        }),
        close: () => new Promise<void>(() => {}),
      };
      return browser;
    };

    const runPastTheLimits = async () => {
      vi.useFakeTimers();
      launch.mockResolvedValueOnce(hungBrowser());
      const hung = pdf.renderPdf("<p>hung</p>").then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(pdf.PDF_RENDER_TIMEOUT_MS + pdf.BROWSER_CLOSE_TIMEOUT_MS);
      expect(await hung).toBeInstanceOf(pdf.PdfBusyError);
    };

    let signals: Array<[number, string | number | undefined]>;
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      setPlatform("linux");
      signals = [];
      vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
        signals.push([pid, signal]);
        return true;
      });
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("is killed, with its process group, when it is this server's child at launch and still is before the kill", async () => {
      readFile.mockResolvedValue(statLine(CHROMIUM, "chrome", ME, "777001"));

      await runPastTheLimits();

      expect(readFile.mock.calls, "asked at launch and again right before the kill").toEqual([[`/proc/${CHROMIUM}/stat`, "utf8"], [`/proc/${CHROMIUM}/stat`, "utf8"]]);
      expect(signals).toEqual([[-CHROMIUM, "SIGKILL"]]);
      expect(warn.mock.calls.at(-1)).toEqual(["[pdf] Chromium did not close within 10000 ms and was killed"]);
    });

    it("is left alone when the id it reported is not a child of this server", async () => {
      readFile.mockResolvedValue(statLine(CHROMIUM, "chrome", ME + 1, "777001"));

      await runPastTheLimits();

      expect(signals, "no signal to a process this server did not start").toEqual([]);
      expect(warn.mock.calls.at(-1)).toEqual(["[pdf] Chromium did not close within 10000 ms; its process could not be identified, leaving it to Playwright"]);
    });

    it("is left alone when the id belongs to another parent's process by the time of the kill", async () => {
      // Same start time on purpose: the parent alone decides here.
      readFile.mockResolvedValueOnce(statLine(CHROMIUM, "chrome", ME, "777001")).mockResolvedValue(statLine(CHROMIUM, "chrome", 1, "777001"));

      await runPastTheLimits();

      expect(readFile).toHaveBeenCalledTimes(2);
      expect(signals).toEqual([]);
      expect(warn.mock.calls.at(-1)).toEqual(["[pdf] Chromium did not close within 10000 ms; its process could not be identified, leaving it to Playwright"]);
    });

    it("is left alone when its /proc line cannot be read", async () => {
      readFile.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));

      await runPastTheLimits();

      expect(signals).toEqual([]);
    });
  });
});
