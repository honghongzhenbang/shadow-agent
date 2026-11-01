import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { associateSpeakers } from "../src/voice-speaker-index.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-index-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const index = path.join(root, "index.sqlite");
  const link = (sourceKey, embedding, label="speaker_00", extra={}) => associateSpeakers(index, {
    sourceKey, audioSha256:"a".repeat(64), transcript:{
      segments:[{id:"s",startMs:0,endMs:4000,text:"test",speakerLabel:label}],
      speakers:[{label,embedding,embeddingModel:"model-a", ...extra}],
    },
  }).speakers[0];
  return { link, index };
}
test("separate files and restarts reuse one acoustic ID without asserting identity", (t) => {
  const {link} = fixture(t);
  const a=link("one",[1,0]), b=link("two",[0.99,0.01]);
  assert.equal(a.voiceId,b.voiceId);
  assert.equal(b.status,"acoustic_match");
  assert.equal(b.identityConfirmed,false);
  assert.deepEqual(link("one",[1,0]),a);
});
test("different people and model versions do not share IDs", (t) => {
  const {link} = fixture(t);
  const a=link("one",[1,0]), b=link("two",[0,1]);
  assert.notEqual(a.voiceId,b.voiceId);
  assert.notEqual(link("three",[1,0],"speaker_00",{embeddingModel:"model-b"}).voiceId,a.voiceId);
});
test("short/unknown audio never gets a guessed stable identity", (t) => {
  const {link}=fixture(t);
  link("one",[1,0]);
  assert.equal(link("two",[1,0],"unknown").voiceId,null);
  assert.equal(link("three",[1,0],"speaker_00",{speechDurationMs:600}).voiceId,null);
});
test("ambiguous candidates do not merge or create a new permanent person", (t) => {
  const {link}=fixture(t);
  link("one",[1,0]); link("two",[0,1]);
  assert.equal(link("three",[1,1]).status,"ambiguous");
  assert.equal(link("four",[1,1]).voiceId,null);
});
test("automatic matches do not drift the enrollment anchor", (t) => {
  const {link}=fixture(t);
  link("one",[1,0]);
  assert.equal(link("two",[0.8,0.6]).status,"acoustic_match");
  assert.equal(link("three",[0.6,0.8]).status,"ambiguous");
});
test("mutated source cannot silently rewrite prior links", (t) => {
  const {link}=fixture(t);
  link("one",[1,0]);
  assert.throws(()=>link("one",[0,1]),/source changed/);
});
test("different local labels in the same file cannot collapse onto one voice", (t) => {
  const {link}=fixture(t);
  const a=link("one",[1,0]);
  assert.equal(link("one",[0.99,0.01],"speaker_01").voiceId,null);
  assert.equal(link("two",[1,0]).voiceId,a.voiceId);
});

test("separate long-file processing scopes can reuse an anonymous voice without confirming a person", t => {
  const {link} = fixture(t);
  const a = link("long", [1, 0], "b0_speaker_00", {acousticScope:"block-0"});
  const b = link("long", [1, 0], "b1_speaker_00", {acousticScope:"block-1"});
  assert.equal(a.voiceId, b.voiceId);
  assert.equal(b.identityConfirmed, false);
  assert.equal(link("long", [1,0], "b1_speaker_01", {acousticScope:"block-1"}).voiceId, null);
});
