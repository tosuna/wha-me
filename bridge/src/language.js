// BCP 47 tag -> English name of its language for agent prompts ('es-MX' -> 'Spanish').
export const languageName = (tag) => new Intl.DisplayNames(['en'], { type: 'language' }).of(new Intl.Locale(tag).language);
