# Auto-deploy: step by step

What it does: when you push a change to GitHub, your server rebuilds the site by itself. You do not click Deploy any more.
You set it up once per GitHub repository.

## Step 0: update the server (once)

1. Open PowerShell on your computer and connect:
   `ssh -i $env:USERPROFILE\.ssh\vyre_deploy root@147.182.171.109` (type your key's passphrase if asked).
2. When the prompt shows `root@deploy-vyre`, paste these three lines, one at a time:
   ```
   cd /opt/vyre
   git pull
   docker compose --env-file .env -f server/compose.yml up -d --build
   ```
3. Wait until it says `Started`. Type `exit`. Your sites keep running while this happens.

## Step 1: get the webhook address and secret from your dashboard

1. Open https://deploy.vyrechain.com and sign in (email empty, your owner password).
2. Find the site in the list and click **Manage**.
3. Click **Auto-deploy from GitHub**. A box appears with:
   - **Payload URL**: starts with `https://deploy.vyrechain.com/hooks/github/`
   - **Secret**: a long string of letters and numbers
   - a line saying which branch and which apps it covers.
4. Keep this page open. You will copy the Payload URL and the Secret in the next step.
   Tip: double-click the text to select it all, then copy. Do not copy extra spaces.

## Step 2: add the webhook on GitHub

Do this in the repo that holds the site's code. Direct links (they open the right page):
- Texas sites (Spring, Tomball, Cypress, College Station, all four use this one repo): https://github.com/PettyMiggzy/Junk-Junkie-Texas/settings/hooks/new
- Indiana: https://github.com/PettyMiggzy/jji/settings/hooks/new
- Florida: https://github.com/PettyMiggzy/Florida-junk/settings/hooks/new

(If the link asks you to confirm your password, do. If it says 404, you are signed in to the wrong GitHub account.)

Fill in the form exactly like this:
1. **Payload URL**: paste the Payload URL from Step 1.
2. **Content type**: choose **application/json** from the dropdown. This one matters: the default is wrong.
3. **Secret**: paste the Secret from Step 1.
4. **SSL verification**: leave it on "Enable SSL verification".
5. **Which events would you like to trigger this webhook?**: choose **Just the push event.**
6. Make sure **Active** is ticked.
7. Click the green **Add webhook** button.

The Texas repo feeds four sites, so you add ONE webhook for it, not four. Any of the four sites' Manage pages shows the same address and secret.

## Step 3: check that it works

1. On GitHub you land on the Webhooks list. Your new webhook has a green tick after a few seconds. (GitHub sends a test message called a "ping".)
2. If it shows a red mark: click the webhook, open **Recent Deliveries**, click the top one, and read the **Response** tab. See "If something is wrong" below.
3. Real test: change something small in the repo (for example, edit a word on a page) and commit it to the same branch the dashboard box named (usually `main`). Within a minute the site's Manage page in the dashboard shows a build running, then your change is live.
   Without changing anything: in the webhook's Recent Deliveries, click a delivery and press **Redeliver**. That sends the same push again.

## What gets rebuilt, and what it costs

- Only pushes to the branch the app was deployed from. The box says, for example, "Every push to the main branch". If your changes go to another branch, nothing happens until they are merged into that branch.
- Every app from that repository rebuilds (all four Texas sites at once).
- Several pushes in a row become one extra build, not one each.
- Your own (owner) sites cost nothing. A customer account pays for each build from its USDC credit; a push is skipped, and a note is written in the app's log, when the credit is too low.

## If something is wrong

Open the webhook on GitHub, Recent Deliveries, click one, Response tab:
- `Bad signature` (401): the Secret does not match. Go back to the dashboard, click **New secret**, copy it again carefully, and paste it into the webhook's Secret field (Edit the webhook, tick "change secret"). Also check Content type is application/json.
- `Unknown hook` (404): the Payload URL is wrong or incomplete. Copy it again from the dashboard.
- The delivery shows a timeout or cannot connect: the server is down or not updated (do Step 0).
- `ignored: a different repository` or an empty list `{"deploying":[],...}`: the push was to another branch, or no app on this account is built from this repo and branch.
- `skipped`: that account is a customer without enough credit (see the app's log in the dashboard).
- Changed something and nothing rebuilt: check the branch name in the box against where you pushed.

## Keep it safe

- The Secret proves a push came from GitHub. Do not share it. If it leaks, click **New secret** in the dashboard and update the webhook on GitHub.
- Only repos on github.com work. A customer's private repo cannot be built (customer builds never get your GitHub access).
