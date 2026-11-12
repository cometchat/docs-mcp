## Summary

What does this change and why?

## Type of change

- [ ] New implementation bundle
- [ ] Bundle page list change (`src/bundles/manifest.ts`)
- [ ] Tool / server change
- [ ] Docs
- [ ] Other

## Checklist

- [ ] `npm test` passes
- [ ] `claude plugin validate . --strict` passes (if manifests changed)
- [ ] Docs tools remain read-only; every account tool has a `title` and a `readOnlyHint` or `destructiveHint`, and writes that change existing data use `confirm`; no behavioral instructions in tool descriptions
- [ ] Changed bundle pages: updated `BUNDLES_REVIEWED` in `src/bundles/manifest.ts` and ran `npm run verify:bundles`
