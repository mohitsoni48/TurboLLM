// GENERATED FILE — do not edit.
// Source: src/templates/*.md. Regenerate with: node scripts-build-templates.mjs
// (test.mjs fails if this file is stale, so an un-regenerated edit cannot ship.)

export const confirmation = `---
subject: {{subjectLine}}
---

Hi {{first}},

{{opening}}

{{pill:#{{position}}}}

> You said you can test on: **{{platforms}}**.

When a build is ready for one of those, it comes to this address with instructions. That is the only thing you will get. No newsletter, no drip campaign.

:::desktop
> The desktop builds are not code-signed yet, so Windows will show a SmartScreen warning and macOS will ask you to right-click and choose Open the first time. That is expected, not a sign something is wrong.
:::

:::android
> Android testing runs through the Play Store, so the invite has to go to the Google account your phone signs in with. If that is a different address to this one, just reply and tell me which to use.
:::

> Want your details removed, at any point? Reply to this email and they are gone.

> If you didn't apply for this, someone typed your address by mistake. Reply and I'll delete it.

Mohit
[turbollm.dev](https://turbollm.dev)
`

export const invite = `---
subject: Your TurboLLM {{platformLabel}} build is ready
---

Hi {{first}},

The {{platformLabel}} build is ready, and you're on the list for it.

{{cta:Get the {{platformLabel}} build|{{url}}}}

:::android
> Open the link, tap "Become a tester", and it hands you a Play Store link to install from. Two steps rather than one, which is just how Google does closed tests.

> Use the same Google account this email arrived at. The test is restricted to accounts on the tester list, so a different account will tell you the test is not available rather than explaining why.
:::

:::windows
> Windows will show a SmartScreen warning, because the build is not code-signed yet. "More info" then "Run anyway". If that is a dealbreaker, it is a completely reasonable one — just reply and say so.
:::

:::macos
> macOS will refuse it on a double-click, because the build is not notarised yet. Right-click the app, choose Open, then confirm. That path exists precisely for unsigned builds.
:::

:::mobile
> It runs the model on your phone's own CPU, so smaller models (2-4B) feel far better than large ones, and the phone will get warm while it is generating. That is the honest state of on-device inference today, not a bug.
:::

:::desktop
> It runs entirely on your machine, so speed depends on your hardware rather than on our servers.
:::

> This is an early build. If something breaks, reply to this email and tell me what device you're on and what you did just before it went wrong — that's genuinely more useful than a polite "it crashed".

Thanks for testing it.

Mohit
[turbollm.dev](https://turbollm.dev)
`
