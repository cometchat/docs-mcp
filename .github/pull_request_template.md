## Summary

What does this change and why?

## Type of change

- [ ] New implementation bundle
- [ ] Bundle page list change (`src/bundles/manifest.ts`)
- [ ] Tool / server change (within the read-only contract)
- [ ] Docs
- [ ] Other

## Checklist

- [ ] `npm test` passes
- [ ] `claude plugin validate . --strict` passes (if manifests changed)
- [ ] Tools remain read-only (`readOnlyHint: true`); no behavioral instructions in tool descriptions
- [ ] Changed bundle pages: updated `BUNDLES_REVIEWED` in `src/bundles/manifest.ts` and ran `npm run verify:bundles`
