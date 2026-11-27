const COUNTRY_HEADERS = ['cf-ipcountry', 'cloudfront-viewer-country', 'x-vercel-ip-country', 'x-appengine-country', 'x-country-code'];
export function countryOf(request) {
    for (const name of COUNTRY_HEADERS) {
        const value = request.headers[name];
        const code = (Array.isArray(value) ? value[0] : value)?.trim().toUpperCase();
        if (code && /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1')
            return code;
    }
    return undefined;
}
export function regionOf(country, languages) {
    if (country)
        return country === 'CN' ? 'cn' : 'global';
    return languages[0]?.toLowerCase().startsWith('zh') ? 'cn' : 'global';
}
export const SPEECH_CHOICES = ['doubao', 'gemini'];
export function isSpeechChoice(value) {
    return value === 'doubao' || value === 'gemini';
}
export function speechChoiceFor(languages) {
    return languages[0]?.trim().toLowerCase().startsWith('zh') ? 'doubao' : 'gemini';
}
export function speechChain(choice, set) {
    const order = choice === 'doubao'
        ? [set.doubao, set.doubaoIme, set.wetype, set.gemini]
        : [set.gemini, set.doubao, set.doubaoIme];
    return order.filter((p) => Boolean(p));
}
export function providerChain(region, set) {
    return speechChain(region === 'cn' ? 'doubao' : 'gemini', set);
}
