# Production-rooted release executor

`npm run release:execute` is the local source-composition boundary for the one-release dependency update that cannot be built from current `main`. It does one job: materialize an exact build context from deployed production source plus authorized `package.json` and `package-lock.json` bytes. It does not select a branch, create a ref or object in the controller repository, query a package source, install dependencies, build an image, call GitHub or Azure, run a migration, or deploy.

This is intentionally narrower than the normal app-only release runbook. A successful run says only that source was composed; build, image, recovery, release and production verification remain separate gates.

## Fixed source plan

The v1 controller admits exactly this previously audited structural plan:

| identity | Git object |
| --- | --- |
| production commit | `6e251b1d047ed82427717ef595ef6872e95af3b5` |
| production tree | `6e9d3817118597c396e9b5b9c678105bc27e0de9` |
| composed `package.json` blob | `b74dac5dba6af30889877cace6a1055aab562327` |
| composed `package-lock.json` blob | `2fc8d918cad6964ed3da64be11ce07e949f5e3fd` |
| composed payload tree | `ba4aa54f147fd3bce9e5c54345b2226f14e0a36d` |

The payload diff against the production tree must be exactly `package-lock.json` and `package.json`, in that order. The controller does not accept a selected ref, commit overlay, cherry-pick, third path, changed object identity or caller-supplied alternative plan.

## Authority boundary

Four authority records are mandatory: `controller`, `source`, `payload` and `package`. Each is a separate external file with a separately supplied lowercase SHA-256 root. The files and package inputs must be regular, non-symlink files outside the controller checkout. Authority records are UTF-8 canonical JSON: recursively sorted object keys, no insignificant whitespace, and one final LF.

Each record has this strict schema; no other fields are accepted:

```json
{
  "authorityId": "a-unique-accepted-record-id",
  "decision": "allow",
  "issuer": "accepted-authority",
  "kind": "markdoc-release-authority",
  "release": {
    "changedPaths": ["package-lock.json", "package.json"],
    "controllerCommit": "<clean-controller-commit>",
    "controllerTree": "<clean-controller-tree>",
    "packageBlob": "b74dac5dba6af30889877cace6a1055aab562327",
    "packageLockBlob": "2fc8d918cad6964ed3da64be11ce07e949f5e3fd",
    "payloadTree": "ba4aa54f147fd3bce9e5c54345b2226f14e0a36d",
    "productionCommit": "6e251b1d047ed82427717ef595ef6872e95af3b5",
    "productionTree": "6e9d3817118597c396e9b5b9c678105bc27e0de9"
  },
  "schemaVersion": 1,
  "scope": "controller"
}
```

Only `scope`, `authorityId` and, when appropriate, `issuer` differ between the four records. All four roots, files and IDs must be distinct, and all four records must bind the byte-identical release tuple. The root arguments are trust inputs supplied by the accepted authority process; discovering a JSON file beside the controller is deliberately not authority.

The repository contains no authority records or package inputs. Consequently, an invocation without the externally accepted records returns `release-executor: STOP` and creates nothing. Structural permission or a matching hash alone does not synthesize a missing package decision.

## Run

Run from a clean checkout of the accepted controller commit. Keep every input and the new output directory outside that checkout:

```text
npm run release:execute -- \
  --controller-authority <file> --controller-root <64-hex> \
  --source-authority <file> --source-root <64-hex> \
  --payload-authority <file> --payload-root <64-hex> \
  --package-authority <file> --package-root <64-hex> \
  --package-json <file> --package-lock <file> \
  --output <new-directory>
```

Use `--check` instead of `--output` to perform the same composition and delete it. Syntax errors exit 2. A missing or mismatched gate exits 1 with `STOP`. Only an exact check or atomic stage exits 0.

After all authority files and candidate blobs pass, the controller creates a temporary Git object directory and index outside the checkout. It reads the immutable production tree through an alternate object directory, writes only the two candidate blobs into quarantine, calculates and compares the payload tree, checks the two-path diff, then checks out that index. The quarantine is always removed. A retained payload has no `.git` directory; a failure leaves no output, ref or object in the controller repository.
