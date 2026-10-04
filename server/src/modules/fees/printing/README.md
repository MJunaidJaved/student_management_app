# Ported thermal receipt printing

These two `.legacy.js` files were rescued from `frontend/electron/` before the
Milk POS trees were deleted. Module 5 asks for a "thermal-printer-friendly
format, reusing the idea from the old POS" for fee receipts, and this is that
code.

They are kept **as-is, unconverted**, and are not imported by anything yet.

- `escpos-receipt.legacy.js` — builds an ESC/POS byte buffer (text, alignment,
  cut commands) for a 58mm/80mm thermal printer.
- `print-raw-windows.legacy.js` — sends a raw byte buffer to a Windows printer
  queue, bypassing the driver's rendering.

## What has to change in Phase 5

1. **It is Electron code.** `print-raw-windows.legacy.js` assumes a desktop
   process with access to the local printer spooler. The server has no printer.
   The realistic split is: the server returns the ESC/POS byte buffer over an
   authenticated endpoint, and whatever runs at the fee counter sends it to the
   printer. Only `escpos-receipt` belongs on the server.
2. **The line items are milk-domain.** Product name, quantity, unit price. Fee
   receipts carry a fee category, a discount, a fine and an allocation across
   invoices, which is a different shape.
3. **The money is float-based**, like everything in the old POS. Every amount
   must go through `core/money` instead.
4. Convert to TypeScript and drop the `.legacy` suffix once adapted.

Until then, treat these as reference material, not as working code.
