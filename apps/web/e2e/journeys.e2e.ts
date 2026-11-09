import { expect, type Page, test } from "@playwright/test";

const EMAIL = "browser@example.com";
const PASSWORD = "correct-horse-battery";

/**
 * Gets to a signed-in page: through Set up on a new install, else through
 * the sign-in form, so the suite runs on a fresh server or again on the same.
 */
async function signIn(page: Page) {
  await page.goto("/");
  const setup = page.getByRole("heading", { name: "Set up Sling" });
  const login = page.getByRole("heading", { name: "Sign in to Sling" });
  await expect(setup.or(login).or(page.getByRole("navigation"))).toBeVisible();
  if (await setup.isVisible()) {
    await page.getByLabel("Name").fill("Browser");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
  } else if (await login.isVisible()) {
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(page.getByRole("navigation").first()).toBeVisible();
}

/** A chat with one message in it, made through the API the app uses. */
async function chatWith(page: Page, text: string): Promise<string> {
  const headers = { origin: new URL(page.url()).origin };
  const created = await page.request.post("/api/conversations", { data: {}, headers });
  const { id } = (await created.json()) as { id: string };
  await page.request.post(`/api/conversations/${id}/messages`, { data: { text }, headers });
  return id;
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("sends a message once even when the first response is lost", async ({ page }) => {
  const id = await chatWith(page, "Hello from the browser suite");
  await page.goto(`/c/${id}`);
  await expect(page.getByRole("heading", { name: "Hello from the browser suite" })).toBeVisible();

  // The server takes the first send, but its answer never reaches the page.
  let lost = false;
  await page.route(`**/api/conversations/${id}/messages`, async (route) => {
    if (route.request().method() !== "POST" || lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort("connectionreset");
  });
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("Only once, please");
  await box.press("Enter");
  // The draft stays for another try, which goes out with the same ID.
  await expect(box).toHaveValue("Only once, please");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(box).toHaveValue("");
  await expect(page.getByText("Only once, please")).toHaveCount(1);
  await page.reload();
  await expect(page.getByText("Only once, please")).toHaveCount(1);
});

test("keeps an unsent draft per chat through switching and reloading", async ({ page }) => {
  const first = await chatWith(page, "First chat");
  const second = await chatWith(page, "Second chat");
  await page.goto(`/c/${first}`);
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("Half a thought");
  await page.goto(`/c/${second}`);
  await expect(box).toHaveValue("");
  await page.goto(`/c/${first}`);
  await expect(box).toHaveValue("Half a thought");
  await page.reload();
  await expect(box).toHaveValue("Half a thought");
});

test("archives a chat and restores it from the Archived tab", async ({ page }) => {
  const title = `Archive me ${Date.now()}`;
  await chatWith(page, title);
  await page.goto("/chats");
  const row = page.getByRole("link", { name: title });
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: `Actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(row).toHaveCount(0);

  await page.getByRole("tab", { name: "Archived" }).click();
  await row.click();
  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("button", { name: "Restore" })).toHaveCount(0);
  await page.goto("/chats");
  await expect(row).toBeVisible();
});

test("keeps keyboard focus in a dialog and returns it to the menu that opened it", async ({
  page,
}) => {
  const title = `Rename me ${Date.now()}`;
  await chatWith(page, title);
  await page.goto("/chats");
  const trigger = page.getByRole("button", { name: `Actions for ${title}` });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename chat" });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("moves between tabs with the arrow keys", async ({ page }) => {
  await page.goto("/tasks");
  const all = page.getByRole("tab", { name: "All tasks" });
  await all.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Running/ })).toBeFocused();
  await expect(page.getByRole("tab", { name: /Running/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Done" })).toBeFocused();
});

test("shows how to pair a machine", async ({ page }) => {
  await page.goto("/machines");
  await page.getByRole("button", { name: "Add machine" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/sling-runner/).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("comes back live after the connection drops", async ({ page, context }) => {
  await page.goto("/chats");
  const live = page.getByText("Live", { exact: true });
  await expect(live).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByText("Reconnecting", { exact: true })).toBeVisible({ timeout: 90_000 });
  await context.setOffline(false);
  await expect(live).toBeVisible({ timeout: 60_000 });
});
