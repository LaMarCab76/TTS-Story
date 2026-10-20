/* studio.js — shared helpers for the TTS-Story "Estudio" UI.
   Classic script. Defines globals only: no DOM access, timers or storage at load time,
   so it does not depend on script order. */

/**
 * Deterministic speaker color (hex) matching --st-spk-1..10.
 * Uses the speaker's position in orderedNames when present, otherwise a stable hash of the name.
 */
window.studioSpeakerColor = function studioSpeakerColor(name, orderedNames) {
    const palette = [
        '#c4b8a5', '#dd9581', '#94b89e', '#8fb3c9', '#d6b46a',
        '#b79ac8', '#e0a3b4', '#9fc2b5', '#c9a27e', '#a8b47c'
    ];
    const key = String(name == null ? '' : name).trim().toLowerCase();
    let index = -1;
    if (Array.isArray(orderedNames)) {
        index = orderedNames.findIndex(item => String(item == null ? '' : item).trim().toLowerCase() === key);
    }
    if (index < 0) {
        let hash = 0;
        for (let i = 0; i < key.length; i += 1) {
            hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
        }
        index = Math.abs(hash);
    }
    return palette[index % palette.length];
};

/** Programmatic navigation: clicks the sidebar tab button so every tab listener runs. */
window.studioGoToTab = function studioGoToTab(tab) {
    const button = document.querySelector(`.tab-button[data-tab="${String(tab || '')}"]`);
    if (!button) return false;
    button.click();
    return true;
};

/** "Just now", "2 min ago", "3 h ago", "Yesterday", or a short date. */
window.studioRelativeTime = function studioRelativeTime(dateOrIso) {
    if (dateOrIso === null || dateOrIso === undefined || dateOrIso === '') return '';
    let date;
    if (dateOrIso instanceof Date) {
        date = dateOrIso;
    } else if (typeof dateOrIso === 'number') {
        date = new Date(dateOrIso < 1e12 ? dateOrIso * 1000 : dateOrIso);
    } else {
        date = new Date(dateOrIso);
    }
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const diffSeconds = Math.round((now.getTime() - date.getTime()) / 1000);
    if (diffSeconds < 45) return 'Just now';
    const minutes = Math.round(diffSeconds / 60);
    if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
    const hours = Math.floor(minutes / 60);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
    if (date >= startOfToday || hours < 6) return `${Math.max(1, hours)} h ago`;
    if (date >= startOfYesterday) return 'Yesterday';
    const options = { month: 'short', day: 'numeric' };
    if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
    return date.toLocaleDateString(undefined, options);
};

/** Escapes a value for safe use inside HTML attributes (and text): & < > " ' */
window.studioEscapeAttr = function studioEscapeAttr(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};
