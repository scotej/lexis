# Screen fonts

The two faces `styles.css` sets the app in. They are here rather than named and
hoped for, because the stack they replaced resolved to whatever the desktop had
— on a Linux machine carrying only DejaVu, every headword and typing passage
was set in a face the stylesheet was never drawn against.

`charis-sil-*.woff2` is **Charis SIL** (regular, italic, bold), SIL's extended
release of the Bitstream Charter design the `--serif` stack has always asked
for first. `inter-*.woff2` is **Inter**, carrying the chrome that used to fall
to `system-ui`: the upright files are one variable file per subset covering the
whole weight axis, the italics are static Regulars. `styles.css` declares the
uprights `100 900` and the italics `400`, which is what the files actually
hold — a face that claims a weight it does not carry is set at the wrong one
rather than synthesised.

Both are unmodified Google Fonts builds, subset exactly as Google serves them:
`-latin` covers ASCII and the common punctuation, `-latin-ext` the accented
ranges plus IPA — so an English bank fetches the latin files alone and pays for
the rest only where an entry needs it. The `unicode-range` descriptors in
`styles.css` must stay in step with the file each one names.

Licences are beside the files: `CharisSIL-LICENSE.txt` and `Inter-LICENSE.txt`,
both SIL Open Font License 1.1.

Nothing here is fetched from a CDN, and the Tauri build's `default-src 'self'`
covers them without a further rule. The `.ttf` files in the parent directory
are a separate matter — they are embedded into exported PDFs, never rendered on
screen; see `../../vendor/README.md`.
