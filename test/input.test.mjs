#!/usr/bin/env node --experimental-strip-types
// Run: npm test
import { isPrivateHost, urlToSource, chunkText, youtubeId, paragraphize, isAudioName }
  from "../lib/extract.ts";

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

// A server that fetches any address its client names is a way into whatever
// else that server can reach. On a hosted deploy that means cloud metadata.
console.log("private and internal addresses are refused:");
for (const host of [
  "localhost", "app.localhost", "service.internal",
  "127.0.0.1", "127.1.2.3", "0.0.0.0",
  "10.0.0.5", "172.16.4.1", "172.31.255.254", "192.168.1.1",
  "169.254.169.254",  // the cloud metadata endpoint
  "100.64.0.1",       // carrier-grade NAT
  "::1", "fe80::1", "fd00::1", "[::1]",
]) {
  check(host, isPrivateHost(host), true);
}

console.log("\npublic addresses are allowed:");
for (const host of [
  "example.com", "en.wikipedia.org", "8.8.8.8", "1.1.1.1",
  "172.32.0.1",   // just outside the private range
  "172.15.0.1",   // just below it
  "192.169.1.1",  // not 192.168
  "169.253.1.1",  // not link-local
  "100.63.0.1", "100.128.0.1",  // either side of carrier-grade NAT
  "2606:4700::1111",
]) {
  check(host, isPrivateHost(host), false);
}

console.log("\nnon-web addresses are refused before any request is made:");
const refuses = async (url, fragment) => {
  try {
    await urlToSource(url);
    return "no error";
  } catch (e) {
    return e.message.includes(fragment) ? "refused" : `wrong reason: ${e.message}`;
  }
};
check("a file:// path", await refuses("file:///etc/passwd", "http and https"), "refused");
check("an ftp address", await refuses("ftp://example.com/x", "http and https"), "refused");
check("gibberish", await refuses("not a url", "isn't a web address"), "refused");
check("localhost", await refuses("http://localhost:3000/", "private network"), "refused");
check("cloud metadata",
  await refuses("http://169.254.169.254/latest/meta-data/", "private network"), "refused");

// The happy path — fetch, strip, reject a thin page — needs a real page, and
// the guard exists precisely to stop this reaching a local test server. It is
// covered against a live URL through the running app instead; see the browser
// run in PLAN.md.

console.log("\na YouTube link is recognised however it was copied:");
for (const [url, want] of [
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"],
  ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://youtu.be/dQw4w9WgXcQ?t=30", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
]) {
  check(url.replace("https://", ""), youtubeId(url), want);
}

console.log("\nanything else is left to the ordinary page fetcher:");
for (const url of [
  "https://en.wikipedia.org/wiki/Photosynthesis",
  "https://www.youtube.com/",
  "https://www.youtube.com/@someone",
  "https://youtu.be/",
  "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=tooshort",
  "not a url",
]) {
  check(url, youtubeId(url), null);
}

console.log("\ncaptions are broken into blocks the chunker can split on:");
const stream = Array.from({ length: 350 }, (_, i) => `word${i}`).join(" ");
const blocked = paragraphize(stream);
check("blank lines appear", blocked.includes("\n\n"), true);
check("into several blocks", blocked.split("\n\n").length, 4);
check("no word is lost", blocked.split(/\s+/).length, 350);
check("order is kept", blocked.split(/\s+/)[0] + " " + blocked.split(/\s+/)[349], "word0 word349");
check("a short transcript stays as one block", paragraphize("a b c").includes("\n\n"), false);
check("chunking then finds real boundaries", chunkText(blocked, 800, 16).length > 1, true);

console.log("\na recording is recognised by name, since the bytes only name a container:");
for (const name of ["lecture.mp3", "LECTURE.M4A", "seminar.wav", "talk.aac", "notes.flac",
                    "x.ogg", "x.opus", "recording.mp4", "clip.mov", "screen.webm"]) {
  check(name, isAudioName(name), true);
}
for (const name of ["chapter.pdf", "slides.pptx", "notes.txt", "scan.png", "paper.docx",
                    "no-extension", "archive.mp3.zip"]) {
  check(name, isAudioName(name), false);
}

console.log("\nseveral files merged into one deck still chunk on their own boundaries:");
const merged = ["## notes-one.txt", "", "Alpha. ".repeat(200), "", "## notes-two.txt", "", "Beta. ".repeat(200)]
  .join("\n");
const chunks = chunkText(merged, 1200, 16);
check("it splits into several sections", chunks.length > 1, true);
check("the first file's heading survives", chunks[0].includes("notes-one.txt"), true);
check("so does the second's", chunks.some((c) => c.includes("notes-two.txt")), true);
check("no content is dropped", chunks.join("").includes("Beta."), true);

console.log(failures === 0 ? "\nall input checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
