import { fetchWordUpgrades } from "./core/dict.js";

/** A thesaurus search is a read: the source word never enters the bank. */
export function installWordUpgrades({ document = globalThis.document, onLookup,
  findUpgrades = fetchWordUpgrades }) {
  const $ = id => document.getElementById(id);
  const input = $("upgrade-input");
  const form = $("upgrade-form");
  const button = $("upgrade-find");
  const status = $("upgrade-status");
  const results = $("upgrade-results");
  let sequence = 0;
  let pending = null;

  input.addEventListener("input", () => {
    sequence++;
    pending = null;
    button.disabled = false;
    results.replaceChildren();
    status.hidden = true;
    status.classList.remove("error");
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const word = input.value.trim().toLowerCase();
    if (!word || pending === word) return;
    const seq = ++sequence;
    pending = word;
    button.disabled = true;
    results.replaceChildren();
    status.hidden = false;
    status.classList.remove("error");
    status.textContent = `finding alternatives to “${word}”…`;
    try {
      const words = await findUpgrades(word);
      if (seq !== sequence) return;
      status.textContent = words.length
        ? `alternatives to “${word}” · open a word to check its meaning and add it to your bank`
        : `no stronger alternatives found for “${word}” · try another word`;
      for (const candidate of words) {
        const item = document.createElement("li");
        const lookup = document.createElement("button");
        lookup.type = "button";
        lookup.className = "link-quiet headword";
        lookup.textContent = candidate.word;
        lookup.setAttribute("aria-label", `look up ${candidate.word}`);
        lookup.addEventListener("click", () => onLookup(candidate.word));
        item.append(lookup);
        results.append(item);
      }
    } catch (error) {
      if (seq !== sequence) return;
      status.textContent = String(error.message ?? error);
      status.classList.add("error");
    } finally {
      if (seq === sequence) {
        pending = null;
        button.disabled = false;
      }
    }
  });
}
