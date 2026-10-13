# DCO Skill

Every commit message must include a Developer Certificate of Origin (DCO) sign-off line.

## Format

- The commit message MUST end with exactly one `Signed-off-by:` line
- The sign-off line certifies that you have the right to submit the work under the project's license
- The name and email in the sign-off line MUST match `git config user.name` and `git config user.email`

**Always use `git commit -s` (or `--signoff`) to automatically append the sign-off line.** Do NOT manually write
`Signed-off-by:` in the commit message body — the `-s` flag handles it. Manually adding it alongside `-s` will produce
duplicate DCO lines, which is invalid.

If a commit ends up with multiple `Signed-off-by:` lines, amend it to keep only one.

Format:

```
:shortcode: your commit message here

Signed-off-by: <git config user.name> <git config user.email>
```