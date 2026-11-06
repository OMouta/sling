# Task alerts

A workflow package with one template, **Notify when a task finishes**. When a coding task finishes, it sends a push notification through [ntfy](https://ntfy.sh) to your phone or desktop:

- the title says whether the task is done, failed, or stopped, followed by the task's title
- the text is the task's summary, or its error, then the repo and where it ran
- failed and stopped tasks use priority 4, which makes a sound on phones
- tapping it opens the pull request, when the task opened one

It runs no code and asks for no permissions. It needs the **ntfy** extension, 1.0 or later.

## Use it

1. Install **ntfy** and **Task alerts** under **Extensions → Discover**.
2. Under **Connectors**, add an ntfy installation and set its **Default topic**. On ntfy.sh, pick a long name nobody will guess, and subscribe to it in the ntfy app.
3. Under **Workflows**, choose **New from template**, pick **Notify when a task finishes**, and choose the ntfy installation for **ntfy server**.
4. Turn the workflow on.

To notify on more than finishing, open the workflow and add `approval_needed` or `delivered` to the trigger's reasons.
