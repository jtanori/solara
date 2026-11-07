# 4. Editorial PDF downloads

## What is implemented

`@react-pdf/renderer` generates the PDF server-side on the Node.js runtime. A signed-in user can download only their own chart from `/api/readings/<id>/pdf`. The response is an attachment with `Cache-Control: private, no-store`. Free accounts receive a two-page summary; active Premium accounts receive an additional page of Moon, Ascendant and house reflections. English and Spanish use the selected interface language. Built-in PDF fonts are used; no PDF service or API key is required.

The PDF is generated from the **current** editorial notes, not an immutable report snapshot. The on-screen wheel is decorative and is not a calculated chart plot. Interpretations and calculations are preliminary.

## Local setup

1. Complete the foundation setup and create a test account and saved chart. Open the chart and choose **Download PDF summary**.
2. Switch languages and repeat. Run `npx tsx --test tests/pdf.test.ts` to test free and Premium PDF generation without Stripe credentials. To test Premium in the UI, use a real Stripe test-mode subscription and webhook rather than changing a plan flag in the browser.
3. Confirm a signed-out request is rejected and a different account cannot download the chart. Inspect page count, accents, line wrapping and the return time.

## Staging setup

1. Deploy the Node.js runtime with `@react-pdf/renderer` externalized as configured in `next.config.ts`. Create only synthetic test charts.
2. Test free and test-subscribed accounts in ES/EN, long names/content, high-latitude omissions, page breaks, download headers and cross-account authorization. Test on mobile and common PDF viewers.
3. Watch function execution time and memory. If report complexity or volume increases, assess asynchronous generation and private storage; neither is currently implemented.

## Production setup

1. Complete astronomical, editorial and security validation first. Verify that the hosting platform supports the Node runtime, PDF generation limits and expected traffic.
2. Monitor generation errors without logging birth details or document contents. Preserve private/no-store responses and owner checks. Test one controlled download in each plan and language after deployment.
3. Before promising permanent purchased reports, add versioned editorial content and immutable report snapshots or clearly communicate that downloads may change after an edit. Define retention, deletion and accessibility requirements.

Reference: [React-PDF Node API](https://react-pdf.org/node).
