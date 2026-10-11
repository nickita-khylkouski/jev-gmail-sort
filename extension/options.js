const $ = (s) => document.querySelector(s);
const status = (t, err) => {
  $("#status").textContent = t;
  $("#status").className = err ? "err" : "";
};
chrome.storage.local.get(["key", "about", "openai", "presort"]).then(({ key = "", about = "", openai = "", presort = true }) => {
  $("#presort").checked = presort;
  $("#key").value = key;
  $("#openai").value = openai;
  $("#about").value = about;
});
$("#save").onclick = async () => {
  await chrome.storage.local.set({ key: $("#key").value.trim(), about: $("#about").value.trim(), openai: $("#openai").value.trim(), presort: $("#presort").checked });
  status("Saved. Open Gmail and press Sort.");
};
$("#test").onclick = async () => {
  status("Testing…");
  try {
    const t0 = performance.now();
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${$("#key").value.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state: { x: 1 }, questions: { ok: { type: "choice", instructions: "Is x equal to 1?", criteria: { yes: "x is 1", no: "x is not 1" } } } }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    status(`Key works · ranking API answered in ${Math.round(performance.now() - t0)}ms`);
  } catch (e) {
    status("Key failed: " + e.message, true);
  }
};
