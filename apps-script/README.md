# Apps Script — write-back endpoint for the /leads CRM

The `/leads` page uses this Apps Script as its write-back endpoint. Edits
made in the CRM (status, called, responded, notes, assigned caller) flow
through `/api/update` on Vercel, which posts to this script, which writes
the change to the actual Google Sheet.

## One-time setup

1. Open the **IIP Leads** Google Sheet
   (https://docs.google.com/spreadsheets/d/14YB5KhwvAVnyw6zDdxa0AZhscIIDq4l7OUyzi3vfODk/edit).

2. **Extensions → Apps Script**. A new tab opens with an empty `Code.gs`.

3. Delete whatever's there and paste the entire contents of `Code.gs`
   from this folder.

4. _(Optional but recommended)_ At the top of the file, set
   `SHARED_SECRET` to any random string (e.g. a UUID). Remember it —
   you'll add the same value to Vercel below. Leaving it blank disables
   secret-checking.

5. Click **Deploy → New deployment**.
   - **Select type:** _Web app_ (gear icon next to "Select type")
   - **Description:** anything (e.g. `IIP CRM writer v1`)
   - **Execute as:** _Me (your account)_
   - **Who has access:** _Anyone_
   - Click **Deploy**.

6. Google will ask you to authorize. Approve all scopes.

7. Copy the **Web app URL** (ends with `/exec`).

8. In the Vercel project settings → **Environment Variables**, add:
   - `APPS_SCRIPT_URL` = the URL from step 7
   - `APPS_SCRIPT_SECRET` = same value as `SHARED_SECRET` in `Code.gs`
     (or leave unset if you didn't set one)

9. Trigger a redeploy on Vercel so the new env vars take effect
   (e.g. push any commit, or hit "Redeploy" from the Vercel dashboard).

## Verifying

After the redeploy, open https://iip-dashboard.vercel.app/leads, find a
lead, change its status. The row should briefly turn yellow ("saving")
then flash green ("saved"), and the new value should appear in the
underlying Google Sheet within a second or two.

If anything fails, you'll see a toast in the bottom-right corner with
the error message. Common causes:

- _"APPS_SCRIPT_URL env var not set"_ — env var missing on Vercel, or
  Vercel hasn't been redeployed since you added it.
- _"unauthorized"_ — `APPS_SCRIPT_SECRET` doesn't match the
  `SHARED_SECRET` in the script.
- _"sheet not found"_ — the script is bound to the wrong spreadsheet.
  Make sure you opened the Apps Script editor _from inside_ the IIP
  Leads sheet (not as a standalone project).

## Updating the script later

If you change `Code.gs`, you must redeploy the web app. In Apps Script:
**Deploy → Manage deployments → pencil icon → Version: New version →
Deploy**. The URL stays the same. No Vercel changes needed.
