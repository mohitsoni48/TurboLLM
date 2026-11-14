import { describe, expect, it } from 'vitest'
import { detectLanguage, languageName, languageScript, primaryLanguage } from './language'

const PARAGRAPHS: Record<string, string> = {
  en: 'I looked at the error message you pasted, and it seems the problem is in how the configuration file is loaded. Try moving the settings into a separate folder and restart the server. If that does not help, send me the full log and we can go through it together.',
  es: 'Claro, puedo ayudarte con eso. Primero tienes que abrir la configuración del programa y buscar la opción de idioma. Si no la encuentras, dime qué versión estás usando y te explico cómo cambiarla paso a paso.',
  'pt (Brazil)':
    'Claro, posso te ajudar com isso. Primeiro você precisa abrir as configurações do aplicativo e procurar a opção de idioma. Se não encontrar, me diga qual versão você está usando e eu explico como mudar passo a passo.',
  'pt (Portugal)':
    'Claro, posso ajudar-te com isso. Primeiro tens de abrir as definições da aplicação e procurar a opção do idioma. Se não a encontrares, diz-me que versão estás a usar e eu explico-te como a mudar, passo a passo.',
  fr: "Bien sûr, je peux vous aider avec cela. Vous devez d'abord ouvrir les paramètres de l'application et chercher l'option de langue. Si vous ne la trouvez pas, dites-moi quelle version vous utilisez et je vous expliquerai comment la changer.",
  de: 'Natürlich helfe ich dir dabei. Zuerst musst du die Einstellungen der Anwendung öffnen und nach der Sprachoption suchen. Wenn du sie nicht findest, sag mir bitte, welche Version du benutzt, und ich erkläre dir Schritt für Schritt, wie du sie ändern kannst.',
  it: "Certo, posso aiutarti con questo. Prima devi aprire le impostazioni dell'applicazione e cercare l'opzione della lingua. Se non la trovi, dimmi quale versione stai usando e ti spiego come cambiarla passo dopo passo.",
  nl: 'Natuurlijk kan ik je daarmee helpen. Eerst moet je de instellingen van de applicatie openen en de taalopties zoeken. Als je die niet kunt vinden, vertel me dan welke versie je gebruikt, dan leg ik stap voor stap uit hoe je het kunt veranderen.',
  pl: 'Oczywiście, mogę ci w tym pomóc. Najpierw musisz otworzyć ustawienia aplikacji i znaleźć opcję języka. Jeśli jej nie możesz znaleźć, powiedz mi, której wersji używasz, a wyjaśnię ci krok po kroku, jak ją zmienić.',
  tr: 'Tabii, bu konuda sana yardımcı olabilirim. Önce uygulamanın ayarlarını açman ve dil seçeneğini bulman gerekiyor. Eğer bulamazsan, hangi sürümü kullandığını söyle, ben de sana nasıl değiştireceğini adım adım anlatayım.',
  sv: 'Visst, jag kan hjälpa dig med det. Först måste du öppna inställningarna i appen och leta efter språkalternativet. Om du inte hittar det, berätta vilken version du använder så förklarar jag steg för steg hur du ändrar det.',
  da: 'Selvfølgelig kan jeg hjælpe dig med det. Først skal du åbne indstillingerne i appen og lede efter sprogindstillingen. Hvis du ikke kan finde den, så fortæl mig hvilken version du bruger, og jeg forklarer dig meget gerne, hvordan du ændrer den trin for trin.',
  no: 'Selvfølgelig kan jeg hjelpe deg med det. Først må du åpne innstillingene i appen og lete etter språkvalget. Hvis du ikke finner det, si fra hvilken versjon du bruker, så forklarer jeg deg veldig gjerne hvordan du endrer det trinn for trinn.',
  fi: 'Totta kai, voin auttaa sinua siinä. Ensin sinun täytyy avata sovelluksen asetukset ja etsiä kieliasetus. Jos et löydä sitä, kerro minulle, mitä versiota käytät, niin selitän sinulle vaihe vaiheelta, miten sen voi vaihtaa.',
  id: 'Tentu, saya bisa membantu Anda dengan itu. Pertama, Anda perlu membuka pengaturan aplikasi dan mencari opsi bahasa. Jika tidak menemukannya, beri tahu saya versi yang Anda gunakan, dan saya akan menjelaskan cara mengubahnya langkah demi langkah.',
  vi: 'Tất nhiên, tôi có thể giúp bạn việc đó. Trước tiên, bạn cần mở phần cài đặt của ứng dụng và tìm tùy chọn ngôn ngữ. Nếu bạn không tìm thấy, hãy cho tôi biết bạn đang dùng phiên bản nào, rồi tôi sẽ hướng dẫn bạn cách thay đổi từng bước.',
  ro: 'Sigur, te pot ajuta cu asta. Mai întâi trebuie să deschizi setările aplicației și să cauți opțiunea pentru limbă. Dacă nu o găsești, spune-mi ce versiune folosești și îți explic pas cu pas cum să o schimbi.',
  cs: 'Samozřejmě, s tím vám mohu pomoci. Nejdřív musíte otevřít nastavení aplikace a najít volbu jazyka. Pokud ji nenajdete, řekněte mi, jakou verzi používáte, a já vám krok za krokem vysvětlím, jak ji změnit.',
  hu: 'Persze, ebben szívesen segítek neked. Először meg kell nyitnod az alkalmazás beállításait, és meg kell keresned a nyelvi opciót. Ha nem találod, mondd meg, melyik verziót használod, és lépésről lépésre elmagyarázom, hogyan tudod megváltoztatni.',
  ca: "És clar que et puc ajudar amb això. Primer has d'obrir la configuració de l'aplicació i buscar l'opció d'idioma. Si no la trobes, digues-me quina versió fas servir i t'explicaré pas a pas com canviar-la.",
  ru: 'Конечно, я могу вам с этим помочь. Сначала нужно открыть настройки приложения и найти параметр языка. Если вы его не найдёте, скажите мне, какую версию вы используете, и я шаг за шагом объясню, как её изменить.',
  uk: 'Звісно, я можу вам із цим допомогти. Спочатку потрібно відкрити налаштування застосунку й знайти параметр мови. Якщо ви його не знайдете, скажіть мені, яку версію ви використовуєте, і я крок за кроком поясню, як її змінити.',
  bg: 'Разбира се, мога да ви помогна с това. Първо трябва да отворите настройките на приложението и да намерите опцията за език. Ако не я откриете, кажете ми каква версия използвате и ще ви обясня стъпка по стъпка как да я промените.',
  el: 'Φυσικά, μπορώ να σε βοηθήσω με αυτό. Πρώτα πρέπει να ανοίξεις τις ρυθμίσεις της εφαρμογής και να βρεις την επιλογή γλώσσας. Αν δεν τη βρίσκεις, πες μου ποια έκδοση χρησιμοποιείς και θα σου εξηγήσω βήμα βήμα πώς να την αλλάξεις.',
  ar: 'بالتأكيد، يمكنني مساعدتك في ذلك. أولاً عليك فتح إعدادات التطبيق والبحث عن خيار اللغة. إذا لم تجده، أخبرني بالإصدار الذي تستخدمه وسأشرح لك كيفية تغييره خطوة بخطوة.',
  fa: 'حتماً، می‌توانم در این مورد به شما کمک کنم. ابتدا باید تنظیمات برنامه را باز کنید و گزینه زبان را پیدا کنید. اگر آن را پیدا نکردید، به من بگویید چه نسخه‌ای استفاده می‌کنید تا قدم به قدم توضیح بدهم که چگونه آن را تغییر دهید.',
  he: 'בטח, אני יכול לעזור לך בזה. קודם כל צריך לפתוח את הגדרות האפליקציה ולחפש את אפשרות השפה. אם לא מצאת אותה, תגיד לי באיזו גרסה אתה משתמש ואסביר לך צעד אחר צעד איך לשנות אותה.',
  hi: 'बिल्कुल, मैं इसमें आपकी मदद कर सकता हूँ। सबसे पहले आपको ऐप की सेटिंग खोलनी होगी और भाषा का विकल्प ढूँढना होगा। अगर आपको वह न मिले, तो मुझे बताइए कि आप कौन सा संस्करण इस्तेमाल कर रहे हैं, मैं आपको चरण दर चरण समझाऊँगा।',
  bn: 'অবশ্যই, আমি এ বিষয়ে আপনাকে সাহায্য করতে পারি। প্রথমে আপনাকে অ্যাপের সেটিংস খুলে ভাষার বিকল্পটি খুঁজতে হবে। যদি খুঁজে না পান, তাহলে আমাকে বলুন আপনি কোন সংস্করণ ব্যবহার করছেন, আমি ধাপে ধাপে বুঝিয়ে দেব।',
  th: 'ได้เลย ฉันช่วยคุณเรื่องนี้ได้ ก่อนอื่นคุณต้องเปิดการตั้งค่าของแอปแล้วหาตัวเลือกภาษา ถ้าคุณหาไม่เจอ ให้บอกฉันว่าคุณใช้เวอร์ชันไหน แล้วฉันจะอธิบายวิธีเปลี่ยนให้ทีละขั้นตอน',
  'zh (simplified)':
    '当然可以，我来帮你。首先你需要打开应用的设置，然后找到语言选项。如果找不到，请告诉我你用的是哪个版本，我会一步一步地教你怎么修改。',
  'zh (traditional)':
    '當然可以，我來幫你。首先你需要打開應用程式的設定，然後找到語言選項。如果找不到，請告訴我你用的是哪個版本，我會一步一步地教你怎麼修改。',
  ja: 'もちろん、お手伝いできます。まずアプリの設定を開いて、言語のオプションを探してください。見つからない場合は、どのバージョンを使っているか教えてもらえれば、手順を一つずつ説明します。',
  ko: '물론이죠, 도와드릴 수 있어요. 먼저 앱의 설정을 열고 언어 옵션을 찾아야 해요. 찾지 못하셨다면 어떤 버전을 사용하고 계신지 알려주세요. 단계별로 차근차근 설명해 드릴게요.',
}

const expectedFor = (name: string): string => name.split(' ')[0]!

describe('detectLanguage: natural paragraphs', () => {
  for (const [name, text] of Object.entries(PARAGRAPHS)) {
    it(`recognises a ${name} paragraph`, () => {
      expect(detectLanguage(text)).toBe(expectedFor(name))
    })
  }
})

describe('detectLanguage: short single sentences', () => {
  const sentences: Array<[string, string]> = [
    ['en', 'Can you tell me how to reset my password?'],
    ['es', '¿Puedes decirme cómo cambiar mi contraseña en la aplicación?'],
    ['pt', 'Você pode me explicar como funciona essa função no programa?'],
    ['fr', "Pouvez-vous m'expliquer comment fonctionne cette fonction dans le programme ?"],
    ['de', 'Kannst du mir erklären, wie diese Funktion im Programm funktioniert?'],
    ['it', 'Puoi spiegarmi come funziona questa funzione nel programma?'],
  ]
  for (const [lang, text] of sentences) {
    it(`recognises a short ${lang} sentence`, () => {
      expect(detectLanguage(text)).toBe(lang)
    })
  }
})

describe('detectLanguage: classic confusions', () => {
  it('tells Spanish without accents from Portuguese without ã or õ', () => {
    expect(
      detectLanguage('Necesito que me expliques como funciona el sistema para guardar los archivos en el servidor porque no lo entiendo bien.'),
    ).toBe('es')
    expect(
      detectLanguage('Eu preciso que você me explique como funciona o sistema de arquivos, porque ainda tenho muita dúvida sobre isso.'),
    ).toBe('pt')
  })

  it('tells Dutch from German', () => {
    expect(detectLanguage('Ik weet niet of dit werkt, maar we kunnen het later nog een keer proberen als jij tijd hebt.')).toBe('nl')
    expect(detectLanguage('Ich weiß nicht, ob das funktioniert, aber wir können es später noch einmal versuchen, wenn du Zeit hast.')).toBe('de')
  })

  it('tells Italian from Spanish', () => {
    expect(detectLanguage('Non ho ancora capito come funziona questo programma, ma credo che sia molto utile per il nostro lavoro.')).toBe('it')
    expect(detectLanguage('Todavía no he entendido cómo funciona este programa, pero creo que es muy útil para nuestro trabajo.')).toBe('es')
  })

  it('tells Czech from Polish', () => {
    expect(detectLanguage('Nevím, jestli to bude fungovat, ale můžeme to zkusit znovu, až budeš mít čas.')).toBe('cs')
    expect(detectLanguage('Nie wiem, czy to będzie działać, ale możemy spróbować jeszcze raz, kiedy będziesz miał czas.')).toBe('pl')
  })

  it('does not take Indonesian for anything else', () => {
    expect(
      detectLanguage('Saya tidak yakin ini akan berhasil, tetapi kita bisa mencobanya lagi nanti kalau Anda punya waktu. Kalau ada masalah, beri tahu saya.'),
    ).toBe('id')
  })

  it('never calls clear Danish or Norwegian Swedish', () => {
    expect(detectLanguage(PARAGRAPHS.da!)).not.toBe('sv')
    expect(detectLanguage(PARAGRAPHS.no!)).not.toBe('sv')
    expect(detectLanguage(PARAGRAPHS.sv!)).not.toBe('da')
    expect(detectLanguage(PARAGRAPHS.sv!)).not.toBe('no')
  })

  it('may pick either of Danish and Norwegian when nothing tells them apart, but nothing else', () => {
    const result = detectLanguage('Jeg har ikke tid til det nu, men vi kan tale om det senere hvis du vil.')
    expect(['da', 'no', null]).toContain(result)
  })
})

describe('detectLanguage: noisy text', () => {
  it('finds Portuguese around a URL, an e-mail, numbers and English product names', () => {
    const text =
      'Para instalar o Claude Code, acesse https://example.com/docs e siga as instruções. Se tiver dúvidas, escreva para suporte@example.com. A versão 2.1 do llama.cpp usa a GPU quando disponível, e isso pode deixar tudo até 10 vezes mais rápido.'
    expect(detectLanguage(text)).toBe('pt')
  })

  it('finds Japanese among English words', () => {
    const text =
      '今日は新しいGPUについて説明します。Claude Codeを使うと、ファイルの編集がとても簡単になります。まずはinstallの手順を確認してください。'
    expect(detectLanguage(text)).toBe('ja')
  })

  it('finds English around a four-word French quotation', () => {
    const text =
      'My friend said "je ne sais pas" when I asked about the meeting, but I think she knows more than she admits. We should ask her again tomorrow morning before the team call starts.'
    expect(detectLanguage(text)).toBe('en')
  })
})

describe('detectLanguage: no verdict', () => {
  const nothing: Array<[string, string]> = [
    ['an empty string', ''],
    ['whitespace', '   '],
    ['only digits', '12345'],
    ['only an emoji', '👍'],
    ['"OK"', 'OK'],
    ['"Hi"', 'Hi'],
    ['an acronym', 'GPU'],
    ['a bare URL', 'https://example.com/a/b'],
    ['only punctuation', '?!... --- ,, ;: ()[]{} «»'],
  ]
  for (const [name, text] of nothing) {
    it(`returns null for ${name}`, () => {
      expect(detectLanguage(text)).toBeNull()
    })
  }

  it('still decides a single word by its script', () => {
    expect(detectLanguage('こんにちは')).toBe('ja')
    expect(detectLanguage('Привет')).toBe('ru')
    expect(detectLanguage('안녕하세요')).toBe('ko')
    expect(detectLanguage('你好')).toBe('zh')
  })

  it('does not guess a language for a mixed English and Spanish paragraph', () => {
    const text =
      'I think this is a good idea, pero no estoy seguro de que funcione en todos los casos. We can test it tomorrow y luego decidimos qué hacer with the rest of the project.'
    expect(['en', 'es', null]).toContain(detectLanguage(text))
  })
})

describe('detectLanguage: other scripts', () => {
  it('separates Ukrainian, Belarusian, Serbian and Macedonian from Russian by their own letters', () => {
    expect(detectLanguage('Це їхній дім, і вони його люблять')).toBe('uk')
    expect(detectLanguage('Гэта наш дом, і ў ім жывуць людзі')).toBe('be')
    expect(detectLanguage('Ово је моја кућа и ћерка ђак')).toBe('sr')
    expect(detectLanguage('Ова е ќерка и ѓубре на улица')).toBe('mk')
  })

  it('separates Urdu from Persian and Arabic', () => {
    expect(detectLanguage('یہ ایک بہت اچھی کتاب ہے ٹھیک ہے')).toBe('ur')
  })

  it('maps the other single-language scripts', () => {
    expect(detectLanguage('வணக்கம் நண்பர்களே')).toBe('ta')
    expect(detectLanguage('నమస్కారం మిత్రులారా')).toBe('te')
    expect(detectLanguage('નમસ્તે મિત્રો')).toBe('gu')
    expect(detectLanguage('ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਦੋਸਤੋ')).toBe('pa')
    expect(detectLanguage('ನಮಸ್ಕಾರ ಸ್ನೇಹಿತರೇ')).toBe('kn')
    expect(detectLanguage('നമസ്കാരം കൂട്ടുകാരേ')).toBe('ml')
    expect(detectLanguage('გამარჯობა მეგობრებო')).toBe('ka')
    expect(detectLanguage('Բարեւ ընկերներ')).toBe('hy')
  })

  it('lets a non-Latin script lose when Latin dominates', () => {
    expect(detectLanguage('The word for hello in Russian is привет, and people use it every day with friends.')).toBe('en')
  })
})

describe('detectLanguage: long input', () => {
  it('stays fast and looks only at the start', () => {
    const paragraph = PARAGRAPHS['pt (Brazil)']! + ' '
    const long = paragraph.repeat(Math.ceil(50_000 / paragraph.length)).slice(0, 50_000)
    const started = performance.now()
    const result = detectLanguage(long)
    expect(performance.now() - started).toBeLessThan(200)
    expect(result).toBe(detectLanguage(long.slice(0, 2000)))
    expect(result).toBe('pt')
  })

  it('ignores what comes after the examined prefix', () => {
    const text = PARAGRAPHS.en!.repeat(10) + PARAGRAPHS.ru!.repeat(100)
    expect(detectLanguage(text)).toBe('en')
  })
})

describe('Bulgarian and Russian without much ъ', () => {
  it.each([
    'Това е добре, ще го направя утре.',
    'Те са хората, които може да помогнат.',
    'Тази книга е много интересна и ще я прочета довечера.',
    'Така ще звучат отговорите.',
  ])('tells Bulgarian: %s', (text) => {
    expect(detectLanguage(text)).toBe('bg')
  })

  it.each([
    'Это очень хорошо, я уже всё сделал.',
    'Так что мы идём домой, потому что уже поздно.',
    'Что это такое? Я не знаю, что делать.',
    'Это было очень давно, и мы уже не помним, что там было.',
    'Эти ребята живут в моём районе, и мы часто ходим вместе в кино.',
    'Мы ещё не решили, куда поедем в этом году, но это не так важно.',
  ])('keeps Russian: %s', (text) => {
    expect(detectLanguage(text)).toBe('ru')
  })
})

describe('primaryLanguage', () => {
  it('keeps the lower-cased primary subtag', () => {
    expect(primaryLanguage('pt-BR')).toBe('pt')
    expect(primaryLanguage('zh_CN')).toBe('zh')
    expect(primaryLanguage('EN')).toBe('en')
    expect(primaryLanguage('en-US-x-private')).toBe('en')
    expect(primaryLanguage('')).toBe('')
  })
})

describe('languageName', () => {
  it('gives the English name of a language', () => {
    expect(languageName('ja')).toBe('Japanese')
    expect(languageName('pt-BR')).toBe('Portuguese (Brazil)')
    expect(languageName('pt_BR')).toBe('Portuguese (Brazil)')
  })

  it('does not throw on garbage', () => {
    expect(() => languageName('xx-!!')).not.toThrow()
    expect(languageName('xx-!!')).toBe('xx-!!')
    expect(languageName('')).toBe('')
  })
})

describe('languageScript', () => {
  it('puts the Latin-script languages in one script', () => {
    for (const l of ['en', 'es', 'pt', 'fr', 'de', 'tr', 'vi']) expect(languageScript(l)).toBe('latin')
  })

  it('puts Russian, Ukrainian and the other Cyrillic languages in one script', () => {
    expect(languageScript('ru')).toBe('cyrillic')
    expect(languageScript('uk')).toBe('cyrillic')
    expect(languageScript('bg')).toBe('cyrillic')
  })

  it('puts Arabic and Persian in one script', () => {
    expect(languageScript('ar')).toBe('arabic')
    expect(languageScript('fa')).toBe('arabic')
  })

  it('puts Chinese and Japanese in the script of Han characters', () => {
    expect(languageScript('zh')).toBe('han')
    expect(languageScript('ja')).toBe('han')
  })

  it('gives a language with a script of its own, or one it does not know, as itself', () => {
    expect(languageScript('ko')).toBe('ko')
    expect(languageScript('el')).toBe('el')
    expect(languageScript('xx')).toBe('xx')
  })

  it('does not take Object.prototype names for languages', () => {
    expect(languageScript('constructor')).toBe('constructor')
    expect(languageScript('toString')).toBe('toString')
  })

  it('keeps apart the languages detectLanguage can tell, only when they are of different scripts', () => {
    expect(languageScript('es')).toBe(languageScript('pt'))
    expect(languageScript('ja')).not.toBe(languageScript('ko'))
    expect(languageScript('ru')).not.toBe(languageScript('es'))
  })
})
