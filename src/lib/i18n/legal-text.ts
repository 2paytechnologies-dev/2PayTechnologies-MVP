import type { Lang } from "./core";

/**
 * DRAFT legal text. It is written to be accurate about what 2Pay actually does today (and does not do), but it has NOT
 * been reviewed by a lawyer or a certified Amharic legal translator. Have both review it before launch.
 */
export interface LegalSection {
  title: string;
  body: string[];
}
export interface LegalDoc {
  title: string;
  updated: string;
  draftNote: string;
  sections: LegalSection[];
}

export const LEGAL_UPDATED = "2026-10-12";

const termsEn: LegalDoc = {
  title: "Terms of Service",
  updated: `Last updated ${LEGAL_UPDATED}`,
  draftNote: "Draft for legal review.",
  sections: [
    {
      title: "1. What 2Pay is",
      body: [
        "2Pay Technologies (“2Pay”) provides software that lets a business (the “Merchant”) ask a customer for a payment and have it completed through a bank or mobile-wallet partner (a “Rail”).",
        "2Pay is an orchestration service. 2Pay does not hold customer or Merchant funds. Money moves between the customer's account and the Merchant's account through the Rail.",
      ],
    },
    {
      title: "2. Your account",
      body: [
        "You must give accurate information when you register and keep your phone number secure. Anyone who can receive your verification codes can sign in as you.",
        "The Merchant is responsible for everything done under its account, including by cashiers it adds. You can remove a cashier at any time.",
      ],
    },
    {
      title: "3. Payments, fees and settlement",
      body: [
        "A payment is complete only when the Rail confirms it. A screen showing “paid” in demonstration mode does not mean money has moved.",
        "2Pay charges an orchestration fee shown in the Merchant's records. The Rail and your bank or wallet may charge their own fees.",
        "The Merchant is responsible for the settlement accounts it saves. Check them carefully: payments are routed to the accounts you choose.",
      ],
    },
    {
      title: "4. Refunds and disputes",
      body: [
        "A Merchant can request a refund for a paid sale in the app. 2Pay records the request and its review. The money itself is returned through the Rail and may take time.",
        "Disputes between a customer and a Merchant about goods or services are between them.",
      ],
    },
    {
      title: "5. Acceptable use",
      body: [
        "You may not use 2Pay for unlawful activity, fraud, money laundering, or to take payments for goods or services you do not provide. 2Pay may monitor activity, raise compliance alerts, report suspicious activity to the authorities as the law requires, and suspend accounts.",
      ],
    },
    {
      title: "6. Availability",
      body: ["We work to keep 2Pay running but cannot promise it will always be available. Rails and telecom networks can fail. Please keep another way to take payment available."],
    },
    {
      title: "7. Liability",
      body: ["To the extent the law allows, 2Pay is not liable for losses caused by Rail or network failures, incorrect account details entered by users, or events outside our control."],
    },
    {
      title: "8. Changes and contact",
      body: [
        "We may update these terms. If a change is important we will tell you in the app. Continuing to use 2Pay after a change means you accept it.",
        "These terms are governed by the laws of the Federal Democratic Republic of Ethiopia.",
      ],
    },
  ],
};

const termsAm: LegalDoc = {
  title: "የአገልግሎት ውል",
  updated: `መጨረሻ የተሻሻለው ${LEGAL_UPDATED}`,
  draftNote: "ለሕግ ግምገማ የተዘጋጀ ረቂቅ።",
  sections: [
    {
      title: "1. 2Pay ምንድነው",
      body: [
        "2Pay ቴክኖሎጂስ (“2Pay”) አንድ ንግድ (“ነጋዴ”) ከደንበኛ ክፍያ እንዲጠይቅና ክፍያው በባንክ ወይም በሞባይል ቦርሳ አጋር (“የክፍያ መንገድ”) እንዲጠናቀቅ የሚያስችል ሶፍትዌር ያቀርባል።",
        "2Pay የማስተባበሪያ አገልግሎት ነው። 2Pay የደንበኛንም ሆነ የነጋዴን ገንዘብ አይይዝም። ገንዘቡ በክፍያ መንገዱ በኩል ከደንበኛው ሂሳብ ወደ ነጋዴው ሂሳብ ይንቀሳቀሳል።",
      ],
    },
    {
      title: "2. መለያዎ",
      body: [
        "ሲመዘገቡ ትክክለኛ መረጃ መስጠትና የስልክ ቁጥርዎን መጠበቅ አለብዎት። የማረጋገጫ ኮዶችዎን መቀበል የሚችል ማንኛውም ሰው እርስዎን ሆኖ መግባት ይችላል።",
        "ነጋዴው በመለያው ለሚደረገው ሁሉ፣ ነጋዴው የጨመራቸውን ካሼሮች ጨምሮ፣ ኃላፊ ነው። ካሼርን በማንኛውም ጊዜ ማስወገድ ይችላሉ።",
      ],
    },
    {
      title: "3. ክፍያዎች፣ ክፍያዎች (ኮሚሽን) እና ማጠናቀቅ",
      body: [
        "ክፍያ የሚጠናቀቀው የክፍያ መንገዱ ሲያረጋግጠው ብቻ ነው። በሙከራ ሁኔታ “ተከፍሏል” የሚል ማያ ገንዘብ ተንቀሳቅሷል ማለት አይደለም።",
        "2Pay በነጋዴው መዝገብ የሚታይ የማስተባበሪያ ክፍያ ያስከፍላል። የክፍያ መንገዱና ባንክዎ ወይም ቦርሳዎ የራሳቸውን ክፍያ ሊያስከፍሉ ይችላሉ።",
        "ነጋዴው ለሚያስቀምጣቸው የመቀበያ ሂሳቦች ኃላፊ ነው። በጥንቃቄ ያረጋግጧቸው፦ ክፍያዎች ወደመረጧቸው ሂሳቦች ይላካሉ።",
      ],
    },
    {
      title: "4. ገንዘብ መመለስና አለመግባባቶች",
      body: [
        "ነጋዴ ለተከፈለ ሽያጭ በመተግበሪያው ገንዘብ እንዲመለስ መጠየቅ ይችላል። 2Pay ጥያቄውንና ግምገማውን ይመዘግባል። ገንዘቡ የሚመለሰው በክፍያ መንገዱ ሲሆን ጊዜ ሊወስድ ይችላል።",
        "በደንበኛና በነጋዴ መካከል ስለ ዕቃ ወይም አገልግሎት የሚነሱ አለመግባባቶች የራሳቸው ጉዳይ ናቸው።",
      ],
    },
    {
      title: "5. ተቀባይነት ያለው አጠቃቀም",
      body: [
        "2Payን ለሕገ ወጥ ተግባር፣ ማጭበርበር፣ ገንዘብ ማሸሽ፣ ወይም ለማያቀርቡት ዕቃ ወይም አገልግሎት ክፍያ ለመቀበል መጠቀም አይችሉም። 2Pay እንቅስቃሴን ሊከታተል፣ የሕግ ተገዢነት ማንቂያዎችን ሊያስነሳ፣ ሕጉ በሚጠይቀው መሠረት አጠራጣሪ እንቅስቃሴን ለባለሥልጣናት ሊያሳውቅና መለያዎችን ሊያግድ ይችላል።",
      ],
    },
    {
      title: "6. ተደራሽነት",
      body: ["2Payን ሥራ ላይ ለማቆየት እንተጋለን፤ ሁልጊዜ እንደሚገኝ ግን ቃል መግባት አንችልም። የክፍያ መንገዶችና የቴሌኮም አውታረ መረቦች ሊበላሹ ይችላሉ። እባክዎ ክፍያ ለመቀበል ሌላ መንገድ ያዘጋጁ።"],
    },
    {
      title: "7. ኃላፊነት",
      body: ["ሕጉ በሚፈቅደው መጠን፣ 2Pay በክፍያ መንገድ ወይም በአውታረ መረብ ብልሽት፣ ተጠቃሚዎች በሚያስገቡት የተሳሳተ የሂሳብ መረጃ፣ ወይም ከቁጥጥራችን ውጭ በሆኑ ሁኔታዎች ለሚፈጠር ኪሳራ ኃላፊ አይደለም።"],
    },
    {
      title: "8. ለውጦችና ግንኙነት",
      body: [
        "ይህንን ውል ልናሻሽል እንችላለን። ለውጡ አስፈላጊ ከሆነ በመተግበሪያው እናሳውቅዎታለን። ከለውጥ በኋላ 2Payን መጠቀም መቀጠልዎ ለውጡን እንደተቀበሉ ያሳያል።",
        "ይህ ውል በኢትዮጵያ ፌዴራላዊ ዴሞክራሲያዊ ሪፐብሊክ ሕጎች ይገዛል።",
      ],
    },
  ],
};

const privacyEn: LegalDoc = {
  title: "Privacy Policy",
  updated: `Last updated ${LEGAL_UPDATED}`,
  draftNote: "Draft for legal review.",
  sections: [
    {
      title: "1. What we collect",
      body: [
        "Merchants: your phone number, business name and type, the bank and wallet numbers you save for settlement, and (if you submit them for verification) your registered name, TIN, licence number and address.",
        "Customers: the amount and time of a payment, the bank or wallet used, and, only if you enter it, your mobile number (to start the payment and to send an SMS receipt). We do not see your PIN or password.",
        "Technical: your language choice, app version, and error reports so we can fix problems.",
      ],
    },
    {
      title: "2. Why we use it",
      body: [
        "To sign you in, route payments to the right account, show records and reports, prevent fraud and meet our legal duties (including anti-money-laundering rules), send receipts and codes by SMS, and keep the service working.",
      ],
    },
    {
      title: "3. Who we share it with",
      body: [
        "Payment partners (Rails) receive what they need to complete a payment, including the amount, your mobile number and the destination account. Our SMS and hosting providers process data on our behalf. We share information with regulators and law enforcement when the law requires.",
        "We do not sell personal data.",
      ],
    },
    {
      title: "4. How long we keep it",
      body: ["Merchants see 365 days of transaction records in the app. We keep records for as long as the law requires for financial and compliance purposes, then delete or anonymise them."],
    },
    {
      title: "5. Security",
      body: [
        "Account and bank numbers are stored on our servers and are masked on screen. Access is limited by role: a cashier cannot see settlement details. Sensitive actions are logged. No system is perfectly secure, so please protect your phone and verification codes.",
      ],
    },
    {
      title: "6. Your choices and rights",
      body: [
        "You can ask to see, correct or delete your personal data, subject to records we must keep by law. Merchants can switch SMS receipts off in the app. Contact us using the details below.",
      ],
    },
    {
      title: "7. Changes and contact",
      body: ["We will tell you in the app if this policy changes in an important way. This policy follows applicable Ethiopian data protection law."],
    },
  ],
};

const privacyAm: LegalDoc = {
  title: "የግላዊነት ፖሊሲ",
  updated: `መጨረሻ የተሻሻለው ${LEGAL_UPDATED}`,
  draftNote: "ለሕግ ግምገማ የተዘጋጀ ረቂቅ።",
  sections: [
    {
      title: "1. የምንሰበስበው",
      body: [
        "ነጋዴዎች፦ የስልክ ቁጥርዎ፣ የንግድዎ ስምና ዓይነት፣ ለክፍያ መቀበያ የሚያስቀምጧቸው የባንክና የቦርሳ ቁጥሮች፣ እና (ለማረጋገጫ ካስገቡ) የተመዘገበ ስምዎ፣ የግብር ከፋይ ቁጥርዎ፣ የንግድ ፈቃድ ቁጥርዎና አድራሻዎ።",
        "ደንበኞች፦ የክፍያው መጠንና ሰዓት፣ የተጠቀሙበት ባንክ ወይም ቦርሳ፣ እና ካስገቡ ብቻ የሞባይል ቁጥርዎ (ክፍያውን ለመጀመርና የSMS ደረሰኝ ለመላክ)። የይለፍ ቁጥርዎን ወይም የሚስጥር ቃልዎን አናይም።",
        "ቴክኒካዊ፦ የመረጡት ቋንቋ፣ የመተግበሪያ ስሪት፣ እና ችግሮችን ለማስተካከል የስህተት ሪፖርቶች።",
      ],
    },
    {
      title: "2. ለምን እንጠቀምበታለን",
      body: [
        "ለመግባት፣ ክፍያዎችን ወደ ትክክለኛው ሂሳብ ለመላክ፣ መዝገቦችንና ሪፖርቶችን ለማሳየት፣ ማጭበርበርን ለመከላከል፣ የሕግ ግዴታዎቻችንን (የገንዘብ ማሸሽ መከላከያ ደንቦችን ጨምሮ) ለመወጣት፣ ደረሰኞችንና ኮዶችን በSMS ለመላክ፣ እና አገልግሎቱን ሥራ ላይ ለማቆየት።",
      ],
    },
    {
      title: "3. ከማን ጋር እንጋራለን",
      body: [
        "የክፍያ አጋሮች (የክፍያ መንገዶች) ክፍያን ለማጠናቀቅ የሚያስፈልጋቸውን ይቀበላሉ፤ የክፍያውን መጠን፣ የሞባይል ቁጥርዎንና የመድረሻ ሂሳቡን ጨምሮ። የSMS እና የማስተናገጃ አቅራቢዎቻችን በእኛ ምትክ መረጃ ያስተናግዳሉ። ሕጉ ሲጠይቅ ከተቆጣጣሪዎችና ከሕግ አስከባሪዎች ጋር መረጃ እንጋራለን።",
        "የግል መረጃን አንሸጥም።",
      ],
    },
    {
      title: "4. ለምን ያህል ጊዜ እናቆየዋለን",
      body: ["ነጋዴዎች በመተግበሪያው የ365 ቀናት የግብይት መዝገብ ያያሉ። ለገንዘብና ለሕግ ተገዢነት ዓላማ ሕጉ በሚጠይቀው ጊዜ ያህል መዝገቦችን እናቆያለን፤ ከዚያ እንሰርዛቸዋለን ወይም ማንነት አልባ እናደርጋቸዋለን።"],
    },
    {
      title: "5. ደህንነት",
      body: [
        "የመለያና የባንክ ቁጥሮች በአገልጋዮቻችን ላይ ተቀምጠው በማያ ገጽ ላይ ይሸፈናሉ። መዳረሻ በሚና የተገደበ ነው፦ ካሼር የክፍያ መቀበያ ዝርዝሮችን ማየት አይችልም። ስሱ ድርጊቶች ይመዘገባሉ። ምንም ሥርዓት ፍጹም ደህንነቱ የተጠበቀ አይደለም፤ ስለዚህ እባክዎ ስልክዎንና የማረጋገጫ ኮዶችዎን ይጠብቁ።",
      ],
    },
    {
      title: "6. ምርጫዎችዎና መብቶችዎ",
      body: [
        "በሕግ ማቆየት ከሚገባን መዝገቦች በስተቀር፣ የግል መረጃዎን ለማየት፣ ለማስተካከል ወይም ለማጥፋት መጠየቅ ይችላሉ። ነጋዴዎች የSMS ደረሰኞችን በመተግበሪያው ማጥፋት ይችላሉ። ከታች ባሉት መንገዶች ያግኙን።",
      ],
    },
    {
      title: "7. ለውጦችና ግንኙነት",
      body: ["ይህ ፖሊሲ በአስፈላጊ መንገድ ከተለወጠ በመተግበሪያው እናሳውቃለን። ይህ ፖሊሲ የሚመለከተውን የኢትዮጵያ የመረጃ ጥበቃ ሕግ ይከተላል።"],
    },
  ],
};

export const LEGAL: Record<Lang, { terms: LegalDoc; privacy: LegalDoc }> = {
  en: { terms: termsEn, privacy: privacyEn },
  am: { terms: termsAm, privacy: privacyAm },
};
