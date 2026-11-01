import { spawn } from "node:child_process";

export function runCommand(executable, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedForSize = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        killedForSize = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxOutputBytes) stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8").replace(/^\uFEFF/, ""),
        stderr: Buffer.concat(stderr).toString("utf8").replace(/^\uFEFF/, ""),
      };
      if (killedForSize) {
        reject(Object.assign(new Error(`Command output exceeded ${maxOutputBytes} bytes`), { result }));
      } else if (options.check !== false && result.code !== 0) {
        reject(Object.assign(new Error(`Command failed (${result.code}): ${executable} ${args.join(" ")}`), { result }));
      } else {
        resolve(result);
      }
    });
  });
}

export function powershellScriptCommand(scriptPath, args = [], options = {}) {
  return runCommand(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    options,
  );
}
