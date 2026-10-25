/** Local presentation state: searching never changes or fetches bank entries. */
export function installBankSearch({ document = globalThis.document, onChange }) {
  const $ = (id) => document.getElementById(id);
  const input = $("bank-search");
  const clear = $("bank-search-clear");
  const status = $("bank-search-status");
  const normalized = (value) => value.trim().normalize("NFC").toLowerCase();

  input.addEventListener("input", onChange);
  function clearSearch() {
    input.value = "";
    onChange();
    input.focus();
  }
  clear.addEventListener("click", clearSearch);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !input.value) return;
    event.preventDefault();
    event.stopPropagation();
    clearSearch();
  });

  return {
    filterWords(words) {
      const query = normalized(input.value);
      const matches = query
        ? words.filter((entry) => normalized(entry.word).startsWith(query))
        : words;
      $("bank-search-tools").hidden = !words.length;
      clear.hidden = !input.value;
      status.hidden = !query || !words.length;
      status.textContent = !query || !words.length ? ""
        : matches.length
          ? `${matches.length} of ${words.length} words start with “${input.value.trim()}”.`
          : `No words start with “${input.value.trim()}”.`;
      return matches;
    },
  };
}
