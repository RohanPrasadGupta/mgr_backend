import { minorUnit } from "./money";

/**
 * Every currency the app knows: all have daily exchange rates from the FX provider. Each user keeps their own short
 * list of the ones they use (users.currencies); pickers show that list first and the rest under "Other currencies".
 */
export const SEED_CURRENCIES: ReadonlyArray<{ code: string; name: string; symbol: string; minorUnit: number }> = [
  ["THB", "Thai Baht", "฿"], ["NPR", "Nepalese Rupee", "₨"], ["USD", "US Dollar", "$"], ["EUR", "Euro", "€"], ["GBP", "Pound Sterling", "£"],
  ["INR", "Indian Rupee", "₹"], ["JPY", "Japanese Yen", "¥"], ["CNY", "Chinese Yuan", "¥"], ["SGD", "Singapore Dollar", "S$"], ["MYR", "Malaysian Ringgit", "RM"],
  ["AUD", "Australian Dollar", "A$"], ["CAD", "Canadian Dollar", "C$"], ["CHF", "Swiss Franc", "CHF"], ["AED", "UAE Dirham", "د.إ"], ["KRW", "South Korean Won", "₩"],
  ["VND", "Vietnamese Dong", "₫"], ["IDR", "Indonesian Rupiah", "Rp"], ["PHP", "Philippine Peso", "₱"], ["BDT", "Bangladeshi Taka", "৳"], ["LKR", "Sri Lankan Rupee", "Rs"],
  ["PKR", "Pakistani Rupee", "₨"], ["HKD", "Hong Kong Dollar", "HK$"], ["NZD", "New Zealand Dollar", "NZ$"], ["SAR", "Saudi Riyal", "﷼"], ["AFN", "Afghan Afghani", "؋"],
  ["ALL", "Albanian Lek", "L"], ["AMD", "Armenian Dram", "֏"], ["ANG", "Netherlands Antillean Guilder", "ƒ"], ["AOA", "Angolan Kwanza", "Kz"], ["ARS", "Argentine Peso", "$"],
  ["AWG", "Aruban Florin", "ƒ"], ["AZN", "Azerbaijani Manat", "₼"], ["BAM", "Bosnia-Herzegovina Convertible Mark", "KM"], ["BBD", "Barbadian Dollar", "$"], ["BGN", "Bulgarian Lev", "лв"],
  ["BHD", "Bahraini Dinar", "BD"], ["BIF", "Burundian Franc", "FBu"], ["BMD", "Bermudian Dollar", "$"], ["BND", "Brunei Dollar", "B$"], ["BOB", "Bolivian Boliviano", "Bs"],
  ["BRL", "Brazilian Real", "R$"], ["BSD", "Bahamian Dollar", "$"], ["BTN", "Bhutanese Ngultrum", "Nu"], ["BWP", "Botswana Pula", "P"], ["BYN", "Belarusian Ruble", "Br"],
  ["BZD", "Belize Dollar", "BZ$"], ["CDF", "Congolese Franc", "FC"], ["CLP", "Chilean Peso", "$"], ["COP", "Colombian Peso", "$"], ["CRC", "Costa Rican Colón", "₡"],
  ["CUP", "Cuban Peso", "$"], ["CVE", "Cape Verdean Escudo", "$"], ["CZK", "Czech Koruna", "Kč"], ["DJF", "Djiboutian Franc", "Fdj"], ["DKK", "Danish Krone", "kr"],
  ["DOP", "Dominican Peso", "RD$"], ["DZD", "Algerian Dinar", "دج"], ["EGP", "Egyptian Pound", "E£"], ["ERN", "Eritrean Nakfa", "Nfk"], ["ETB", "Ethiopian Birr", "Br"],
  ["FJD", "Fijian Dollar", "FJ$"], ["FKP", "Falkland Islands Pound", "£"], ["GEL", "Georgian Lari", "₾"], ["GHS", "Ghanaian Cedi", "₵"], ["GIP", "Gibraltar Pound", "£"],
  ["GMD", "Gambian Dalasi", "D"], ["GNF", "Guinean Franc", "FG"], ["GTQ", "Guatemalan Quetzal", "Q"], ["GYD", "Guyanese Dollar", "$"], ["HNL", "Honduran Lempira", "L"],
  ["HTG", "Haitian Gourde", "G"], ["HUF", "Hungarian Forint", "Ft"], ["ILS", "Israeli New Shekel", "₪"], ["IQD", "Iraqi Dinar", "ع.د"], ["IRR", "Iranian Rial", "﷼"],
  ["ISK", "Icelandic Króna", "kr"], ["JMD", "Jamaican Dollar", "J$"], ["JOD", "Jordanian Dinar", "JD"], ["KES", "Kenyan Shilling", "KSh"], ["KGS", "Kyrgyzstani Som", "с"],
  ["KHR", "Cambodian Riel", "៛"], ["KMF", "Comorian Franc", "CF"], ["KWD", "Kuwaiti Dinar", "KD"], ["KYD", "Cayman Islands Dollar", "$"], ["KZT", "Kazakhstani Tenge", "₸"],
  ["LAK", "Lao Kip", "₭"], ["LBP", "Lebanese Pound", "L£"], ["LRD", "Liberian Dollar", "$"], ["LSL", "Lesotho Loti", "L"], ["LYD", "Libyan Dinar", "LD"],
  ["MAD", "Moroccan Dirham", "MAD"], ["MDL", "Moldovan Leu", "L"], ["MGA", "Malagasy Ariary", "Ar"], ["MKD", "Macedonian Denar", "ден"], ["MMK", "Myanmar Kyat", "K"],
  ["MNT", "Mongolian Tögrög", "₮"], ["MOP", "Macanese Pataca", "MOP$"], ["MRU", "Mauritanian Ouguiya", "UM"], ["MUR", "Mauritian Rupee", "₨"], ["MVR", "Maldivian Rufiyaa", "Rf"],
  ["MWK", "Malawian Kwacha", "MK"], ["MXN", "Mexican Peso", "$"], ["MZN", "Mozambican Metical", "MT"], ["NAD", "Namibian Dollar", "N$"], ["NGN", "Nigerian Naira", "₦"],
  ["NIO", "Nicaraguan Córdoba", "C$"], ["NOK", "Norwegian Krone", "kr"], ["OMR", "Omani Rial", "﷼"], ["PAB", "Panamanian Balboa", "B/."], ["PEN", "Peruvian Sol", "S/"],
  ["PGK", "Papua New Guinean Kina", "K"], ["PLN", "Polish Złoty", "zł"], ["PYG", "Paraguayan Guaraní", "₲"], ["QAR", "Qatari Riyal", "﷼"], ["RON", "Romanian Leu", "lei"],
  ["RSD", "Serbian Dinar", "дин"], ["RUB", "Russian Ruble", "₽"], ["RWF", "Rwandan Franc", "FRw"], ["SBD", "Solomon Islands Dollar", "SI$"], ["SCR", "Seychellois Rupee", "₨"],
  ["SDG", "Sudanese Pound", "£"], ["SEK", "Swedish Krona", "kr"], ["SHP", "Saint Helena Pound", "£"], ["SLE", "Sierra Leonean Leone", "Le"], ["SOS", "Somali Shilling", "Sh"],
  ["SRD", "Surinamese Dollar", "$"], ["SSP", "South Sudanese Pound", "£"], ["STN", "São Tomé and Príncipe Dobra", "Db"], ["SYP", "Syrian Pound", "£"], ["SZL", "Swazi Lilangeni", "L"],
  ["TJS", "Tajikistani Somoni", "SM"], ["TMT", "Turkmenistani Manat", "m"], ["TND", "Tunisian Dinar", "DT"], ["TOP", "Tongan Paʻanga", "T$"], ["TRY", "Turkish Lira", "₺"],
  ["TTD", "Trinidad and Tobago Dollar", "TT$"], ["TWD", "New Taiwan Dollar", "NT$"], ["TZS", "Tanzanian Shilling", "TSh"], ["UAH", "Ukrainian Hryvnia", "₴"], ["UGX", "Ugandan Shilling", "USh"],
  ["UYU", "Uruguayan Peso", "$U"], ["UZS", "Uzbekistani Som", "soʻm"], ["VES", "Venezuelan Bolívar", "Bs"], ["VUV", "Vanuatu Vatu", "VT"], ["WST", "Samoan Tālā", "WS$"],
  ["XAF", "Central African CFA Franc", "FCFA"], ["XCD", "East Caribbean Dollar", "EC$"], ["XOF", "West African CFA Franc", "CFA"], ["XPF", "CFP Franc", "₣"], ["YER", "Yemeni Rial", "﷼"],
  ["ZAR", "South African Rand", "R"], ["ZMW", "Zambian Kwacha", "ZK"], ["ZWL", "Zimbabwean Dollar", "Z$"],
].map(([code, name, symbol]) => ({ code: code!, name: name!, symbol: symbol!, minorUnit: minorUnit(code!) }));

export const DEFAULT_EXPENSE_CATEGORIES = ["Food", "Transport", "Shopping", "Bills", "Rent", "Health", "Entertainment", "Education", "Other"];
export const DEFAULT_INCOME_CATEGORIES = ["Salary", "Bonus", "Allowance", "Investment", "Other"];
