# Invoice4U MCP מבית Agente

[![CI](https://github.com/agente-dev/invoice4u-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/agente-dev/invoice4u-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@agente-dev/invoice4u-mcp.svg)](https://www.npmjs.com/package/@agente-dev/invoice4u-mcp)

שרת [Model Context Protocol](https://modelcontextprotocol.io) לא-רשמי, צד שלישי, שמעניק לכל סוכן תואם-MCP גישה בטוחה ומוקלדת לחשבון [Invoice4U](https://invoice4u.co.il) — חיפוש מסמכים ולקוחות, ויצירת קבלות המקושרות לחשבוניות ששולמו.

- **לא רשמי:** זהו אינטגרציה קהילתית, **לא מסונפת, לא נתמכת ולא מאושרת על ידי Invoice4U**. שמות Invoice4U מוזכרים לצורך תיאור בלבד. לא נעשה שימוש בסימנים מסחריים או בלוגו של Invoice4U ללא הרשאה.
- **TypeScript / Node.js 24 LTS / MIT** · תעבורת stdio · הרצה מקומית — Agente לעולם לא מחזיק את פרטי ההתחברות שלך ל-Invoice4U.
- **קריאה בלבד כברירת מחדל:** כלי הכתיבה היחיד (יצירת קבלה) אינו נרשם ב-`tools/list` אלא אם הוגדר `INVOICE4U_ALLOW_WRITES=true`.
- **[README באנגלית](./README.md) · עברית (קובץ זה)**

## התחלה מהירה

```json
{
  "mcpServers": {
    "invoice4u": {
      "command": "npx",
      "args": ["-y", "@agente-dev/invoice4u-mcp"],
      "env": {
        "INVOICE4U_API_TOKEN": "your-api-key",
        "INVOICE4U_ENV": "qa",
        "INVOICE4U_ALLOW_WRITES": "false"
      }
    }
  }
}
```

`INVOICE4U_ENV` חייב להיות `qa` או `production` באופן מפורש — לעולם אין ברירת מחדל שקטה ל-production. התחילו מול סביבת ה-QA; זו נקודת ההתחלה הבטוחה המתועדת.

## כלים (משטח v0.1)

| כלי | מצב | תכלית |
|---|---|---|
| `invoice4u_verify_connection` | קריאה | אימות טוקן, סביבה וגישה לארגון |
| `invoice4u_search_documents` | קריאה | חיפוש מסמכים: פתוח/סגור, תאריכים, לקוח, סוג |
| `invoice4u_get_document` | קריאה | שליפה לפי מזהה מסמך, מספר מסמך או מזהה API |
| `invoice4u_search_customers` | קריאה | חיפוש/רשימת לקוחות |
| `invoice4u_get_customer` | קריאה | פרטי לקוח מלאים |
| `invoice4u_list_branches` | קריאה | סניפי הארגון |
| `invoice4u_validate_linked_receipt` | קריאה | בדיקה מקדימה של קבלה: מסמכים, יתרות, הקצאות — ללא כתיבה |
| `invoice4u_create_linked_receipt` | כתיבה | יצירת קבלה מקושרת לחשבוניות קיימות (אידמפוטנטית דרך `apiIdentifier` חובה) |

כלי קריאה מצהירים `readOnlyHint: true, idempotentHint: true`. כלי הכתיבה מצהיר `readOnlyHint: false, destructiveHint: false, idempotentHint: true` — אידמפוטנטיות תקפה רק מכיוון ש-`apiIdentifier` יציב הוא חובה, ותוצאות כפולות או לא-ודאיות נפתרות באמצעות חיפוש לפי המזהה. לאחר פסק-זמן בשליחת כתיבה אין ניסיון חוזר עיוור: השרת בודק תחילה לפי `apiIdentifier` ומנסה שוב רק אם מוכח שלא נוצר מסמך.

סכומי כסף מיוצגים כמחרוזות עשרוניות בגבול ה-MCP (`"12500.00"`), לעולם לא כמספרי נקודה-צפה של JavaScript. תגובות Invoice4U המחזירות HTTP 200 עם שגיאות יישום באוסף `Errors` מנורמלות למודל שגיאות מוקלד — לעולם לא מדווחות כהצלחה.

## הגדרות

פרטי התחברות נמצאים במשתני סביבה בלבד — הטוקן לעולם לא מתקבל כארגומנט של כלי, לעולם לא מוחזר ולעולם לא נרשם בלוגים.

| משתנה | ערכים | ברירת מחדל |
|---|---|---|
| `INVOICE4U_API_TOKEN` | מפתח API | חובה |
| `INVOICE4U_ENV` | `qa` או `production` | חובה — אין ברירת מחדל שקטה ל-production |
| `INVOICE4U_ALLOW_WRITES` | `false` או `true` | `false` |
| `INVOICE4U_LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |

ראו [`.env.example`](./.env.example). נפנים רק למארחי Invoice4U הרשמיים שנבדקו — אין פתח מילוט של כתובת בסיס שרירותית.

## מודל הבטיחות

- **קריאה בלבד כברירת מחדל** — כלי הכתיבה כלל אינו מופיע ב-`tools/list` אלא אם כתיבה הופעלה במפורש.
- **כתיבות אידמפוטנטיות** — `apiIdentifier` יציב הוא חובה; שליחה חוזרת של אותה בקשה לא יכולה ליצור קבלה שנייה.
- **כתיבות מאומתות** — לאחר כל כתיבה השרת שולף מחדש את הקבלה והחשבוניות המוזכרות, ומחזיר יתרות וסטטוסים קודמים/חדשים כפלט מובנה.
- **אין ניסיונות חוזרים עיוורים** בתוצאות כתיבה לא-ודאיות; הפתרון עובר דרך חיפוש `apiIdentifier`.
- **היגיינת סודות** — אין טוקנים או מידע לקוחות בלוגים ברמות רגילות; קבצי דוגמה של QA אינם מכילים נתוני לקוחות אמיתיים.
- **אין תזוזת כספים** — יצירת קבלה מתעדת כסף שכבר התקבל; השרת אינו יכול ליזום תשלומים או לחייב כרטיסים.

## סטטוס

שלב שלד — היישום מנוהל בלוח הפנימי של Agente. `server.json`, `coverage-manifest.json`, `docs/`, `CONTRIBUTING.md`, `SECURITY.md` ו-`CHANGELOG.md` יגיעו עם ספאלד היישום.

## רישיון

MIT — ראו [LICENSE](./LICENSE). © Agente Dev LTD. לא מסונף ל-Invoice4U.
