"""Hindi / Hinglish helpers for subtitles.

Captions are always written in Latin letters: English stays English, Hindi (Devanagari) and mixed
speech become Hinglish ("bhai ye dekh"). `to_latin` is a deterministic transliteration used as a
safety net, so a caption can never show raw Devanagari; the Claude editor refines the common cases
through `romanized.json` (word index -> text), which wins over this module.
"""
from __future__ import annotations

import re

DEVANAGARI = re.compile(r"[ऀ-ॿ]")
LATIN = re.compile(r"[A-Za-z]")

# Very common words whose rule-based spelling would look odd. Keys are Devanagari.
COMMON = {
    "है": "hai", "हैं": "hain", "था": "tha", "थी": "thi", "थे": "the", "हो": "ho", "हूँ": "hoon",
    "और": "aur", "या": "ya", "कि": "ki", "की": "ki", "का": "ka", "के": "ke", "को": "ko", "से": "se",
    "में": "mein", "मैं": "main", "पर": "par", "तो": "toh", "भी": "bhi", "ही": "hi", "ना": "na",
    "नहीं": "nahi", "नही": "nahi", "क्या": "kya", "क्यों": "kyun", "कैसे": "kaise", "कौन": "kaun",
    "ये": "ye", "यह": "yeh", "वो": "woh", "वह": "woh", "यहाँ": "yahan", "वहाँ": "wahan", "अब": "ab",
    "तुम": "tum", "तू": "tu", "आप": "aap", "हम": "hum", "मेरा": "mera", "मेरी": "meri", "मेरे": "mere",
    "तेरा": "tera", "तेरी": "teri", "तुम्हारा": "tumhara", "अपना": "apna", "भाई": "bhai", "यार": "yaar",
    "दोस्त": "dost", "बहुत": "bahut", "कुछ": "kuch", "सब": "sab", "सबको": "sabko", "ऐसा": "aisa",
    "वैसे": "waise", "मतलब": "matlab", "बस": "bas", "चल": "chal", "चलो": "chalo", "देख": "dekh",
    "देखो": "dekho", "देखा": "dekha", "सुन": "sun", "सुनो": "suno", "बोल": "bol", "बोला": "bola",
    "कर": "kar", "करो": "karo", "करना": "karna", "किया": "kiya", "गया": "gaya", "गई": "gayi",
    "लिया": "liya", "दिया": "diya", "जा": "ja", "जाओ": "jao", "आ": "aa", "आओ": "aao", "रहा": "raha",
    "रही": "rahi", "रहे": "rahe", "सकता": "sakta", "सकते": "sakte", "चाहिए": "chahiye", "लेकिन": "lekin",
    "अभी": "abhi", "फिर": "phir", "जब": "jab", "तब": "tab", "कब": "kab", "कहाँ": "kahan", "क्योंकि": "kyunki",
    "एक": "ek", "दो": "do", "तीन": "teen", "चार": "chaar", "पांच": "paanch", "गेम": "game", "वीडियो": "video",
}

VOWELS = {"अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ऋ": "ri", "ए": "e", "ऐ": "ai",
          "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e"}
MATRAS = {"ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri", "े": "e", "ै": "ai",
          "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e"}
CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh",
    "ञ": "ny", "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d",
    "ध": "dh", "न": "n", "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r",
    "ल": "l", "ळ": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h",
}
NUKTA_FORMS = {"क": "q", "ख": "kh", "ग": "g", "ज": "z", "ड": "r", "ढ": "rh", "फ": "f"}
NUKTA, VIRAMA = "़", "्"
SIGNS = {"ं": "n", "ँ": "n", "ः": "h"}
DIGITS = {c: str(i) for i, c in enumerate("०१२३४५६७८९")}


def has_devanagari(text: str) -> bool:
    return bool(DEVANAGARI.search(text or ""))


def _syllables(word: str) -> list[list]:
    """[[consonant_latin, vowel_latin_or_None, explicit], ...]; vowel None = inherent 'a'."""
    out: list[list] = []
    i, n = 0, len(word)
    while i < n:
        ch = word[i]
        if ch in CONSONANTS:
            base = CONSONANTS[ch]
            i += 1
            if i < n and word[i] == NUKTA:
                base = NUKTA_FORMS.get(ch, base)
                i += 1
            if i < n and word[i] == VIRAMA:  # conjunct: consonant without a vowel
                out.append([base, "", True])
                i += 1
                continue
            if i < n and word[i] in MATRAS:
                out.append([base, MATRAS[word[i]], True])
                i += 1
            else:
                out.append([base, None, False])
        elif ch in VOWELS:
            out.append(["", VOWELS[ch], True])
            i += 1
        elif ch in SIGNS:
            out.append(["", SIGNS[ch], True])
            i += 1
        elif ch in DIGITS:
            out.append(["", DIGITS[ch], True])
            i += 1
        else:
            out.append([ch, "", True])  # punctuation, Latin letters, anything else stays as it is
            i += 1
    return out


def _word_to_latin(word: str) -> str:
    if word in COMMON:
        return COMMON[word]
    syl = _syllables(word)
    inherent = [k for k, s in enumerate(syl) if s[1] is None]
    # Schwa deletion: the last inherent 'a' is silent ("samajh", "tum"), and so is a medial one
    # before a vowel-bearing syllable when the previous syllable already has a vowel ("chalta").
    if inherent and inherent[-1] == len(syl) - 1:
        syl[inherent[-1]][1] = ""
        inherent.pop()
    for k in inherent:
        if 0 < k < len(syl) - 1 and syl[k - 1][1] not in (None, "") and syl[k + 1][1] not in ("",):
            syl[k][1] = ""
    return "".join(c + ("a" if v is None else v) for c, v, _ in syl)


def to_latin(text: str) -> str:
    """Transliterate any Devanagari in `text` to Hinglish; Latin text passes through unchanged."""
    if not has_devanagari(text):
        return text
    return re.sub(r"[ऀ-ॿ]+", lambda m: _word_to_latin(m.group(0)), text)


# Latin-script Hindi words: used to tell English from Hinglish when the model wrote Latin letters.
HINGLISH_MARKERS = {
    "bhai", "yaar", "kya", "hai", "hain", "nahi", "nahin", "matlab", "kar", "karo", "ho", "ye", "yeh", "woh",
    "aur", "toh", "bahut", "abhi", "chal", "dekh", "dekho", "suno", "kaise", "kyun", "kyunki", "lekin", "mera",
    "meri", "tera", "teri", "apna", "accha", "acha", "theek", "thik", "sahi", "bas", "ek", "mujhe", "tujhe",
    "humne", "tumne", "bol", "bola", "gaya", "raha", "rahi", "wala", "wali", "isko", "usko", "kuch", "sab",
}


def classify_language(detected: str | None, words: list[str]) -> str:
    """'en', 'hi' or 'hinglish' from the model's language and the words it wrote."""
    toks = [w for w in words if w and re.search(r"\w", w)]
    if not toks:
        return "en" if (detected or "en") == "en" else "hi"
    dev = sum(1 for w in toks if has_devanagari(w))
    lat = sum(1 for w in toks if LATIN.search(w) and not has_devanagari(w))
    dev_ratio = dev / len(toks)
    marker = sum(1 for w in toks if re.sub(r"[^a-z]", "", w.lower()) in HINGLISH_MARKERS) / len(toks)
    if dev_ratio >= 0.9:
        return "hi"
    if dev_ratio >= 0.1:
        return "hinglish"
    if lat and marker >= 0.1:
        return "hinglish"
    if (detected or "en") != "en" and marker >= 0.05:
        return "hinglish"
    return "en"
