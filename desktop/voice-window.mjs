import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, ipcMain } from "electron";
import { createVoiceEnrollmentService } from "../src/voice-enrollment.mjs";
import { createVoiceReview } from '../src/voice-review.mjs';
import { voiceSettings } from '../src/voice-input.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(directory, "voice.html");

export function createVoiceWindowController({ getStore, getConfig, isolated = false }) {
  let window;
  let service;
  let review;
  function getReview() {
    if (!review) {
      const config=getConfig(), settings=voiceSettings(config);
      const database=getStore().db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
      if(!database)throw new Error('Voice review requires a local database.');
      review=createVoiceReview({database,root:settings.root,projectRoot:config.projectRoot,
        matching:{matchThreshold:settings.matchThreshold,matchMargin:settings.matchMargin}});
    }
    return review;
  }
  const channels = [];
  for (const [channel, method] of Object.entries({
    "voice:snapshot": "snapshot", "voice:create-person": "createPerson",
    "voice:confirm": "confirm", "voice:sample": "sample", "voice:revoke": "revoke",
    "voice:progress": "progress",
    "voice:segments": "segments",
    "voice:recordings": "recordings",
    "voice:timeline": "timeline",
    "voice:partials": "partials",
    "voice:samples": "samples", "voice:forget-sample": "forgetSample", "voice:sample-audio": "sampleAudio",
    "voice:revise-segment": "reviseSegment",
    "voice:group": "group", "voice:review": "review", "voice:review-refresh": "reviewRefresh",
  })) {
    ipcMain.handle(channel, (event, input) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
          || event.senderFrame.url !== pathToFileURL(page).href) throw new Error("Untrusted voice window.");
      service ??= createVoiceEnrollmentService(getStore(), getConfig(), { isolated });
      if(method==='review')return getReview().read(input);
      if(method==='reviewRefresh')return getReview().refresh();
      const result=service[method](input);
      if(['confirm','revoke','reviseSegment','createPerson','forgetSample'].includes(method))review?.invalidate();
      if(method==='group')return {...result,assignment:review?.assignment(result.recordingId,result.speakerLabel)};
      return result;
    });
    channels.push(channel);
  }
  return {
    open() {
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return window; }
      window = new BrowserWindow({ width: 1000, height: 740, minWidth: 660, minHeight: 520,
        title: "Shadow Agent · 声纹登记", backgroundColor: "#f5f7f6", show: false,
        autoHideMenuBar: true,
        webPreferences: { preload: path.join(directory, "voice-preload.cjs"), contextIsolation: true,
          nodeIntegration: false, sandbox: true },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.loadFile(page);
      window.once("ready-to-show", () => {
        window?.show(); window?.focus();
        console.log(JSON.stringify({ event: "voice-window-ready", visible: window?.isVisible(), isolated }));
      });
      window.on("closed", () => { window = null;void review?.close();review=undefined; });
      return window;
    },
    dispose() {
      for (const channel of channels) ipcMain.removeHandler(channel);
      void review?.close();review=undefined;
      window?.destroy(); window = null;
    },
  };
}
