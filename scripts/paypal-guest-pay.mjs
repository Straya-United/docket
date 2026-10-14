// Demo/test helper: pays on the Docket quote page through PayPal's sandbox guest card checkout (popup),
// using PayPal's sandbox test card and made-up buyer details. Sandbox only; nothing real is charged.
export const TEST_BUYER = {
  email: 'jane.buyer@example.com', phone: '0412345678', card: '4239539033224173', expiry: '1131', cvv: '123',
  first: 'Jane', last: 'Citizen', line1: '1 Example Street', city: 'Mackay', postcode: '4740',
};

export async function guestCardPay(page, { slow = 0, onPopup, card } = {}) {
  const btnFrame = page.frameLocator('#paypal-buttons iframe').first();
  const [pop] = await Promise.all([page.waitForEvent('popup'), btnFrame.locator('[data-funding-source="card"]').click()]);
  onPopup?.(pop);
  await pop.waitForLoadState();
  const f = (sel) => pop.locator(sel).first();
  await f('#cardNumber').waitFor({ timeout: 30000 });
  const type = async (sel, text) => { const el = f(sel); if (!(await el.isVisible().catch(() => false))) return; await el.click(); await el.fill(''); await el.pressSequentially(text, { delay: slow }); };
  const B = { ...TEST_BUYER, ...(card?.card ? { card: card.card.replace(/\D/g, '') } : {}), ...(card?.expiry ? { expiry: card.expiry.replace(/\D/g, '') } : {}) };
  await type('#email', B.email);
  await type('#phone', B.phone);
  await type('#cardNumber', B.card);
  await type('#cardExpiry', B.expiry);
  await type('#cardCvv', B.cvv);
  await type('#firstName', B.first);
  await type('#lastName', B.last);
  await type('#billingLine1', B.line1);
  await type('#billingCity', B.city);
  const state = pop.locator('select[name="billingState"], #billingState').first();
  if (await state.isVisible().catch(() => false)) await state.selectOption({ label: 'Queensland' }).catch(() => state.selectOption('QLD').catch(() => {}));
  await type('#billingPostalCode', B.postcode);
  // Pay as a guest: make sure "create a PayPal account" is off.
  const sw = pop.locator('#Switch_10, input[type=checkbox][id^="Switch"]').first();
  // count() first: isChecked() on a missing element waits out the 30 s default timeout.
  const hasSwitch = (await sw.count()) > 0;
  for (let i = 0; hasSwitch && i < 3 && await sw.isChecked({ timeout: 1000 }).catch(() => false); i++) {
    const id = await sw.getAttribute('id').catch(() => null);
    const label = id ? pop.locator(`label[for="${id}"]`).first() : null;
    if (label && await label.isVisible().catch(() => false)) await label.click();
    else await sw.evaluate((el) => el.click());
    await pop.waitForTimeout(500);
  }
  if (hasSwitch && await sw.isChecked({ timeout: 1000 }).catch(() => false)) throw new Error('could not switch off "create PayPal account"');
  const noAccount = pop.getByText(/No, I don.t want an account/i).first();
  if (await noAccount.isVisible().catch(() => false)) await noAccount.click();
  await pop.waitForTimeout(400);
  const pay = pop.getByRole('button', { name: /^(Pay Now|Agree & Pay|Pay)$/i }).first();
  await pay.scrollIntoViewIfNeeded();
  await pay.click();
  await pop.waitForEvent('close', { timeout: 60000 });
}
