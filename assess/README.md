# FlagShark migration assessment Action

This Action is a thin client for FlagShark's private LaunchDarkly to
OpenFeature assessment service. It sends the repository's immutable commit SHA
to FlagShark, waits for the assessment, writes the server-rendered Markdown and
JSON reports to the runner. The detailed report is not copied into the GitHub
job summary unless you explicitly opt in, because workflow summaries can be
publicly visible for public repositories.
No LaunchDarkly credential or `GITHUB_TOKEN` is sent by the Action.

Before running an assessment, install the FlagShark GitHub App for the target
repository and bind that installation to your FlagShark workspace. The private
backend uses the App to fetch the exact commit SHA supplied by GitHub Actions.
For LaunchDarkly platform evidence, connect the LaunchDarkly project to the
same workspace and pass its project key; omit the project key for a
repository-only assessment.

GitHub Actions OIDC is the preferred authentication method:

The production API base defaults to `https://api.flagshark.com/api`. Its OIDC
audience deliberately remains the origin, `https://api.flagshark.com`.

```yaml
name: Migration assessment

on:
  workflow_dispatch:

permissions:
  id-token: write

jobs:
  assess:
    runs-on: ubuntu-latest
    steps:
      - name: Assess LaunchDarkly migration
        id: assessment
        uses: FlagShark/flagshark/assess@v2
        with:
          launchdarkly-project-key: production

      - name: Upload assessment reports
        uses: actions/upload-artifact@v4
        with:
          name: flagshark-migration-assessment
          path: |
            ${{ steps.assessment.outputs.markdown-report-path }}
            ${{ steps.assessment.outputs.json-report-path }}
          retention-days: 1
```

The Action itself does not check out or read repository contents, so it does
not need `actions/checkout` or `contents: read`. Add those independently only
when another step in the job needs the working tree; the assessment backend
continues to fetch the immutable SHA through the installed GitHub App.

Uploaded workflow artifacts are available to everyone with read access to the
repository. Treat both reports as sensitive, keep retention short, and omit the
upload step when later jobs do not need the files.

To also render the detailed Markdown report in the workflow job summary, set
`include-report-in-job-summary: true`. This can expose flag keys, file paths,
blockers, and LaunchDarkly-derived details to everyone who can view the
workflow, so it is deliberately disabled by default.

For environments without GitHub OIDC, pass a workspace-scoped token using the
`api-token` input or `FLAGSHARK_API_TOKEN`. Store it as a GitHub Actions secret;
never pass `GITHUB_TOKEN` as the FlagShark API token. Fallback tokens are
currently issued during invite-only onboarding; email
[`joe@flagshark.com`](mailto:joe@flagshark.com). Normal GitHub-hosted workflows
should use OIDC and do not need one.
