# Ozon Viewer — User Guide

Ozon Viewer is a web platform for managing stores on the Ozon and Yandex Market marketplaces. Use it to track prices, update them in bulk, configure the automatic repricer, and manage change history.

**Application URL:** whatever you set in `BETTER_AUTH_URL` (http://localhost:3001 by default)

---

# Managing stores

## Case: Adding an Ozon store

**When you need this:** You want to connect your Ozon store to the system.

**Steps:**
1. Open the **Settings** page (the ⚙️ icon in the menu).
2. Click **Add store**.
3. Pick the **Ozon** platform.
4. Fill in the fields:
   - **Client ID** — find it in Ozon Seller → Settings → API keys.
   - **API Key** — same place, in Ozon Seller.
5. Click **Save**.

**Result:** The store appears in the list on the Settings page and in the header dropdown. The system starts loading products.

**Important:** Client ID and API Key come from your Ozon Seller account (seller.ozon.ru). You cannot connect a store without them.

---

## Case: Adding a Yandex Market store

**When you need this:** You want to connect your Yandex Market store to the system.

**Steps:**
1. Open the **Settings** page (⚙️).
2. Click **Add store**.
3. Pick the **Yandex Market** platform.
4. Fill in the fields:
   - **Business ID** — the business identifier in your Yandex Market account.
   - **Campaign ID** — the campaign (store) identifier.
   - **Api-Key** — the API key from your Yandex Market account.
5. Click **Save**.

**Result:** The store appears in the list. Product synchronization begins.

**Important:** All three fields (Business ID, Campaign ID, Api-Key) are required. You will find them in the API settings section of your Yandex Market account.

---

## Case: Editing store settings

**When you need this:** You need to change an API key, a name, or other store parameters.

**Steps:**
1. Open **Settings** (⚙️).
2. Find the card of the store you want.
3. Click **Settings** on the card.
4. Change the fields you need.
5. Click **Save**.

**Result:** The store settings are updated. If you changed the API key, the next synchronization already uses the new one.

---

## Case: Deleting a store

**When you need this:** You no longer need the store in the system.

**Steps:**
1. Open **Settings** (⚙️).
2. Click **Delete** on the store card.
3. Confirm the deletion in the dialog.

**Result:** The store disappears from the list.

**Important:** ALL store data is deleted permanently — products, price history, snapshots, repricer settings. This cannot be undone.

---

## Case: Switching between stores

**When you need this:** You have several stores and want to move to another one.

**Steps:**
1. In the page header, find the dropdown showing the current store name.
2. Click it and pick the store you want.
3. Or click the store in the sidebar.

**Result:** The product table, prices, and all data switch to the selected store.

---

# Working with prices — bulk

## Case: Uploading prices from Excel as the reference

**When you need this:** You want to set the "right" prices from your own spreadsheet, but NOT push them to the marketplace yet — for example, to prepare a baseline for the repricer.

**Steps:**
1. Click the 📥 button in the header.
2. Upload the Excel file with prices.
3. A preview window opens — check that the offer IDs and prices were parsed correctly.
4. Click **Save reference**.

**Result:** The prices are stored in the system as `ref_price` (the reference price). The repricer will target them. Nothing is sent to the marketplace.

**Important:** Prices from the file are saved as the reference only. To actually update prices on the marketplace, use the case below.

---

## Case: Uploading prices and pushing them to the marketplace

**When you need this:** You want to both store the reference prices and update them on the marketplace right away.

**Steps:**
1. Click the 📥 button in the header.
2. Upload the Excel file.
3. Check the data in the preview window.
4. Click **Reference + Ozon** or **Reference + Yandex** (depending on the store type).

**Result:** The prices are saved as the reference AND sent to the marketplace at the same time. Prices in the product table refresh after the next synchronization.

**Important:** Make sure the correct store is selected before uploading. Prices go to whichever marketplace is currently active.

---

## Case: Unlocking items that deviate by more than 20%

**When you need this:** After an Excel price upload, some items are locked with a 🔒 because the new price differs from the current one by more than 20%.

**Steps:**
1. In the upload preview window, find the items with the 🔒 icon.
2. Click the lock on the item you want.
3. Confirm the unlock.
4. Or click **Unlock all** to unlock every locked item at once.

**Result:** The item becomes available for updating. The lock disappears.

**Important:** The lock is a safeguard against accidental mistakes. If a price differs by more than 20%, it is worth double-checking that it is not a typo in the file.

---

## Case: Excluding items from an upload

**When you need this:** Not every item in the file should be updated — you want to skip some.

**Steps:**
1. In the upload preview window, find the item you want to exclude.
2. Clear the ✅ checkbox next to it.

**Result:** When you click "Save", that item is not updated. The rest are updated as usual.

---

## Case: One Excel file for several stores

**When you need this:** You have a single price list keyed by offer ID for all your stores, and you want to upload it into each store one after another.

**Steps:**
1. Switch to the store you want (the header dropdown).
2. Upload the Excel file via 📥.
3. The system automatically matches the offer IDs present in that store.
4. Offer IDs that do not exist in the store are marked **"Not found in store"**.
5. Save. Repeat for the next store.

**Result:** In each store, only the items whose offer IDs matched are updated.

**Important:** You do not need separate files per store. One file works for all of them — the system sorts it out.

---

# Working with prices — one at a time

## Case: Changing the price of a single product

**When you need this:** You need to quickly change the price of one specific product without uploading a file.

**Steps:**
1. Find the product in the product table.
2. Click the ✏️ (pencil) icon next to the price.
3. Enter the new price.
4. Click **Save**.

**Result:** The new price is sent to the marketplace. The table refreshes with it.

---

## Case: Viewing a product's price history

**When you need this:** You want to see how the price of a specific product changed — who changed it, when, and by how much.

**Steps:**
1. Find the product in the product table.
2. Click the 📈 (chart) icon next to it.

**Result:** A window opens with the price change history: date, old price, new price, and the source of the change.

---

# Repricer

## Case: Turning the repricer on

**When you need this:** You want the system to correct prices automatically whenever they drift away from the reference.

**Steps:**
1. First, upload the reference prices from Excel (see "Uploading prices from Excel as the reference").
2. Open **Settings** (⚙️).
3. Click **Settings** on the card of the store you want.
4. Turn on the **Repricer** toggle.
5. Set the parameters:
   - **Check interval** — how often to check prices (15 minutes by default).
   - **Deviation threshold** — how far from the reference a price must drift before it is corrected (5% by default).
6. Click **Save**.

**Result:** The repricer starts running in the background. If the marketplace price drifts from the reference by more than the configured threshold, the system automatically pulls it back to the reference price.

**Important:** Without uploaded reference prices the repricer has nothing to compare against and will not run. Upload the reference first.

---

## Case: Checking that the repricer is running

**When you need this:** You want to confirm that the repricer is starting up and performing its checks.

**Steps:**
1. Click the 🔄 button in the header.
2. The repricer run log opens.

**Result:** A table of every run: date, time, number of products checked, number of prices corrected.

---

## Case: Seeing what the repricer changed

**When you need this:** You want to know exactly which prices the repricer corrected and why.

**Steps:**
1. Click the 🔄 button in the header.
2. Apply the **Corrected** filter.

**Result:** A table of the products that were corrected: product name, price before, price after, reason for the correction.

---

## Case: Rolling back repricer changes

**When you need this:** The repricer changed prices, but you want the previous ones back.

**Steps:**
1. Click the 📋 button in the header (snapshot history).
2. Go to the **Repricer** tab.
3. Find the snapshot you want by date.
4. Click **Roll back**.
5. Confirm the action.

**Result:** Prices return to their state before the repricer's changes. The new prices are sent to the marketplace.

---

# History and rollback

## Case: Comparing prices before and after

**When you need this:** You want to see what changed after a price upload or a repricer run.

**Steps:**
1. Click the 📋 button in the header.
2. Find the snapshot you want in the list.
3. Click **Compare**.

**Result:** A comparison table opens: product, price before, price after, difference in percent.

---

## Case: Rolling back to earlier prices

**When you need this:** Something went wrong and you need to restore prices to an earlier state.

**Steps:**
1. Click the 📋 button in the header.
2. Find the snapshot you want (by date and description).
3. Click **Roll back**.
4. Confirm the action.

**Result:** Current prices are replaced with the prices from the selected snapshot. The updated prices are sent to the marketplace.

**Important:** A rollback overwrites current prices. Make sure you picked the right snapshot before rolling back.

---

## Case: Manual changes vs the repricer

**When you need this:** You want to tell which changes were made by hand and which were made automatically by the repricer.

**Steps:**
1. Click the 📋 button in the header.
2. You will see two tabs:
   - **Manual changes** — snapshots taken after manual uploads and edits.
   - **Repricer** — snapshots taken after automatic corrections.
3. Switch between the tabs to review them.

**Result:** Separate histories for manual and automatic changes.

**Important:** The last 10 snapshots of each type are kept. Older snapshots are deleted automatically.

---

# Monitoring

## Case: Checking alerts

**When you need this:** You want to know whether any products have problems.

**Steps:**
1. Open the product table.
2. Look at the colored badges above the table:
   - **Red** — critical problems (quarantine, invisible products).
   - **Yellow** — warnings (price mismatch, promotions).
3. Click a badge.

**Result:** The table is filtered down to the products with the selected problem.

---

## Case: Filtering by problem

**When you need this:** You want to quickly find products with a specific problem.

**Steps:**
1. Above the product table, find the filter buttons:
   - **Quarantine** — products in quarantine on the marketplace.
   - **Price≠** — the marketplace price does not match the reference.
   - **Promotions** — products taking part in promotions.
   - **Invisible** — products that are not shown on the storefront.
2. Click the button you need.

**Result:** The table shows only the products with the selected problem.

---

## Case: Viewing API logs

**When you need this:** Something is not working and you need to see which requests go to the marketplace and what comes back.

**Steps:**
1. Click the 📡 button in the header.
2. Use the filters:
   - **Source** — where the request came from (manual, repricer, synchronization).
   - **Status** — success or error.
   - **Period** — the time range to show logs for.

**Result:** A table of every request to the marketplace API: time, type, status, details.

---

## Case: Synchronizing manually

**When you need this:** You want to pull fresh data from the marketplace right now instead of waiting for the automatic synchronization.

**Steps:**
1. Open **Settings** (⚙️).
2. Click **Sync Now** on the card of the store you want.

**Result:** The system requests current data from the marketplace. The product table refreshes within a few minutes.

**Important:** Synchronization also runs automatically on a schedule. Do it manually only when you want to see changes immediately.

---

## Case: Exporting to Excel

**When you need this:** You need to download product and price data as a file.

**Steps:**
1. Open the product table of the store you want.
2. Click the **Export** button above the table.

**Result:** An Excel file downloads with all the products of the current store: offer IDs, names, prices, statuses.

---

# Bulk editing

## Case: Applying a formula to prices

**When you need this:** You need to change prices by a formula — for example, raise them all by 10%.

**Steps:**
1. Open the **Mass Edit** page.
2. Enter a formula, for example: `price * 1.1` (a 10% increase).
3. Click **Preview** — the system shows which prices will change and how.
4. Review the result.
5. Click **Submit**.

**Result:** Prices are recalculated by the formula and sent to the marketplace.

**Important:** Always review the preview before submitting. The formula applies to every product in the store.

---

## Case: Scheduling a price update

**When you need this:** You want prices to update at a specific time — for example, right when a promotion starts.

**Steps:**
1. Open the **Mass Edit** page.
2. Define the changes you want (a formula or a file upload).
3. Click **Schedule**.
4. Pick the date and time.
5. Confirm.

**Result:** The job is saved. Prices update automatically at the specified time.

---

## Case: Canceling a scheduled update

**When you need this:** You changed your mind and want to cancel a scheduled price update.

**Steps:**
1. Open the **Dashboard** page (if available) or **Settings**.
2. Find the scheduled job.
3. Click **Cancel**.

**Result:** The scheduled update is removed. Prices stay unchanged.

---

# Users

## Case: Adding a user

**When you need this:** You need to give someone else access to the system.

**Steps:**
1. Open **Settings** (⚙️).
2. Go to the **Users** section (administrators only).
3. Click **Add user**.
4. Fill in the fields:
   - **Email** — the email address.
   - **Password** — the login password.
   - **Role** — pick one or more roles.
5. Click **Save**.

**Result:** The user can sign in with the email and password you set.

**Important:** The "Users" section is visible to administrators only.

---

## Case: Roles and permissions

**When you need this:** You want to understand who can do what in the system.

**Steps:**
1. When creating or editing a user, pick a role:
   - **admin** — full access to every feature.
   - **repricer** — access to products and prices (viewing, editing, uploading).

**Result:** The user sees only the sections and buttons their role allows.

**Important:** The `admin` role includes every permission. A user with `repricer` can work with products and prices, but not manage users.
