export const SEED_CURRENCIES: ReadonlyArray<{ code: string; name: string; symbol: string; minorUnit: number }> = [
  ["THB", "Thai Baht", "฿"], ["NPR", "Nepalese Rupee", "₨"], ["USD", "US Dollar", "$"], ["EUR", "Euro", "€"],
  ["GBP", "Pound Sterling", "£"], ["INR", "Indian Rupee", "₹"], ["JPY", "Japanese Yen", "¥"], ["CNY", "Chinese Yuan", "¥"],
  ["SGD", "Singapore Dollar", "S$"], ["MYR", "Malaysian Ringgit", "RM"], ["AUD", "Australian Dollar", "A$"],
  ["CAD", "Canadian Dollar", "C$"], ["CHF", "Swiss Franc", "CHF"], ["AED", "UAE Dirham", "د.إ"], ["KRW", "South Korean Won", "₩"],
  ["VND", "Vietnamese Dong", "₫"], ["IDR", "Indonesian Rupiah", "Rp"], ["PHP", "Philippine Peso", "₱"],
  ["BDT", "Bangladeshi Taka", "৳"], ["LKR", "Sri Lankan Rupee", "Rs"], ["PKR", "Pakistani Rupee", "₨"],
  ["HKD", "Hong Kong Dollar", "HK$"], ["NZD", "New Zealand Dollar", "NZ$"], ["SAR", "Saudi Riyal", "﷼"],
].map(([code, name, symbol]) => ({ code: code!, name: name!, symbol: symbol!, minorUnit: ["JPY", "KRW", "VND"].includes(code!) ? 0 : 2 }));

export const DEFAULT_EXPENSE_CATEGORIES = ["Food", "Transport", "Shopping", "Bills", "Rent", "Health", "Entertainment", "Education", "Other"];
export const DEFAULT_INCOME_CATEGORIES = ["Salary", "Bonus", "Allowance", "Investment", "Other"];
