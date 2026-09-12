# PDF assets

`jspdf.umd.min.js` is the unmodified jsPDF 4.2.1 browser bundle, copied from
`node_modules/jspdf/dist/`. Its MIT license is in `jspdf-LICENSE.txt`.
The exact development dependency in package.json pins the reproducible source.
After updating it, copy the bundle and license here and rerun the PDF tests.

`../fonts/DejaVuSans.ttf` and `../fonts/DejaVuSerif.ttf` are unmodified DejaVu
fonts. Their redistribution license is in `../fonts/LICENSE.txt`.

`../fonts/Unifont.ttf` is the unmodified GNU Unifont 15.0.01 TrueType build
from https://unifoundry.com/pub/unifont/unifont-15.0.01/font-builds/.
It supplies broad Unicode fallback coverage under the SIL Open Font License
1.1 (see `../fonts/Unifont-LICENSE.txt`).

The app preloads these local assets at startup and embeds only used glyphs in
each PDF. Neither export nor font loading needs a CDN.
