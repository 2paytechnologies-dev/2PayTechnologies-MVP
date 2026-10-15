# Bank and wallet logos

Put each institution's **official** logo here (SVG preferred, or PNG at least 256 px), exactly as supplied in its brand kit or with its
written permission. 2Pay does not redraw or invent logos.

Suggested file names:

| Institution | File |
|---|---|
| Telebirr | `telebirr.svg` |
| Commercial Bank of Ethiopia | `cbe.svg` |
| CBE Birr | `cbe-birr.svg` |
| Awash Bank | `awash_bank.svg` |
| AwashBirr | `awash_birr.svg` |
| Dashen Bank | `dashen_bank.svg` |
| Amole | `amole.svg` |
| Bank of Abyssinia | `bank_of_abyssinia.svg` |
| Cooperative Bank of Oromia | `coop_bank.svg` |
| Arifpay | `arifpay.svg` |
| Chapa | `chapa.svg` |

Then register each file in `LOGO_FILES` in `src/lib/rail-logos.ts` (the commented lines show the keys). Institutions without a
registered logo show a coloured initials badge, so nothing looks broken in the meantime.

Optional: set `NEXT_PUBLIC_RAIL_LOGO_CDN` (an `https://` URL containing `{slug}`, for example `https://cdn.example.com/rails/{slug}.svg`)
to load logos from a CDN you operate or are licensed to use. Leave it unset to serve only local files.
