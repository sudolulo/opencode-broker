# Contributing

Issues and pull requests are welcome.

- **Run the tests.** `npm test` runs every suite (broker, gateway, HUD) with
  Node's built-in test runner. Node 20.18 or later is required for the module
  mocks the HUD tests use.
- **Add a test with every behaviour change.** Most of this code exists because
  a specific failure happened; a test that fails without the change is what
  keeps it from coming back. Tests must not touch a real installation: point
  `HOME`, `OPENCODE_BROKER_CONFIG` and the socket at temporary paths, as the
  existing suites do.
- **Keep deployment facts in config.** Model names, agent names, profile names
  and scripts belong in the user's config, not in code.
- **Explain why in comments.** When a line exists to prevent a failure, say
  which one.
- **Update `CHANGELOG.md`** under an `Unreleased` heading, in
  [Keep a Changelog](https://keepachangelog.com/) style.

By contributing you agree that your work is released under the MIT license.
