//! Tidying dictated text with the chat model, at the effort level the user picked.

use std::time::Duration;

use super::{SPEECH_LANGUAGE, SPEECH_POLISH_LEVEL};
use crate::error::AppError;
use crate::llm;
use crate::notes::Db;

const POLISH_TIMEOUT: Duration = Duration::from_secs(120);

/// Rules every improvement level shares.
const POLISH_COMMON: &str = "Reply with the corrected text only. Reply in the language of the text and never translate it. Do not add content, do not answer questions in it, do not add line breaks, and do not explain.";
/// Level 2. Each level after it does everything the one before does, and more.
const POLISH_IMPROVED: &str = "You fix text that a speech recognizer heard. Add punctuation and capital letters. Fix words that are clearly recognition errors. Keep the speaker's own words, dialect, and word order.";
/// Level 3: level 2, then proof-reading.
const POLISH_PROOF: &str = "You fix and proof-read text that a speech recognizer heard. First add punctuation and capital letters and fix words that are clearly recognition errors. Then proof-read it: correct spelling and grammar, so it reads as correct standard written language. Keep the meaning, the tone, and everything that was said.";
/// Level 4: level 3, using the note around the words.
const POLISH_CONTEXT: &str = "You fix and proof-read text that a user dictated into a note. You also get the note text before and after it. First add punctuation and capital letters and fix words that are clearly recognition errors. Then proof-read it: correct spelling and grammar, so it reads as correct standard written language. Use the note to pick the right names, terms, and form, and apply spoken corrections such as \"no, I mean\" or \"scratch that\". Keep the meaning, the tone, and everything that was said.";

/// Added at High and Max: the speaker restarting a sentence or saying it again reworded.
const POLISH_CORRECTIONS: &str = "The speaker may correct themselves: they stop and say a phrase or sentence again, reworded. When a later part of the dictated text says an earlier part again, keep only the later version and remove the earlier one. Text in <later> was said right after the dictated text and is not yours to change; when it says the end of the dictated text again, remove that end from your reply. If <later> says all of the dictated text again, reply with [restated] only. Remove nothing that is not said again.";
/// The reply that means every word was said again later.
const RESTATED: &str = "[restated]";

/// Names of the languages the built-in models know, for telling the chat model which one
/// the text is in. Matches the list in the settings window.
const LANGUAGE_NAMES: [(&str, &str); 25] = [
    ("bg", "Bulgarian"),
    ("cs", "Czech"),
    ("da", "Danish"),
    ("de", "German"),
    ("el", "Greek"),
    ("en", "English"),
    ("es", "Spanish"),
    ("et", "Estonian"),
    ("fi", "Finnish"),
    ("fr", "French"),
    ("hr", "Croatian"),
    ("hu", "Hungarian"),
    ("it", "Italian"),
    ("lt", "Lithuanian"),
    ("lv", "Latvian"),
    ("mt", "Maltese"),
    ("nl", "Dutch"),
    ("pl", "Polish"),
    ("pt", "Portuguese"),
    ("ro", "Romanian"),
    ("ru", "Russian"),
    ("sk", "Slovak"),
    ("sl", "Slovenian"),
    ("sv", "Swedish"),
    ("uk", "Ukrainian"),
];

/// The system prompt for one improvement level. A chosen spoken language is named, so a
/// small model does not guess it or drift into English.
fn polish_rules(level: Level, language: &str) -> String {
    let rules = match level {
        Level::Context => POLISH_CONTEXT,
        Level::Proofread => POLISH_PROOF,
        _ => POLISH_IMPROVED,
    };
    let code = language.trim();
    if code.is_empty() {
        return format!("{rules} {POLISH_COMMON}");
    }
    let name = LANGUAGE_NAMES
        .iter()
        .find(|(known, _)| *known == code)
        .map_or_else(
            || format!("the language with code \"{code}\""),
            |(_, name)| (*name).to_string(),
        );
    format!("{rules} The text is in {name}; use correct {name} words and spelling. {POLISH_COMMON}")
}

/// How much the chat model may change dictated text: the effort level shown as Low, Medium,
/// High, and Max.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Low: as the recognizer heard it. No model.
    Basic = 1,
    /// Medium: punctuation, capitals, and clear recognition errors. Dialect stays.
    Improved = 2,
    /// High: spelling and grammar into standard written language.
    Proofread = 3,
    /// Max: proof-read with the memo around the words as context.
    Context = 4,
}

impl Level {
    pub const DEFAULT: Self = Self::Improved;

    pub fn from_number(value: u8) -> Self {
        match value {
            1 => Self::Basic,
            3 => Self::Proofread,
            4 => Self::Context,
            _ => Self::Improved,
        }
    }

    /// The share of the heard words a reply must keep. A reply that keeps fewer is the model
    /// rewriting on its own, and the words stay as heard.
    fn min_kept(self) -> f32 {
        match self {
            Self::Basic => 1.0,
            Self::Improved => 0.6,
            Self::Proofread | Self::Context => 0.35,
        }
    }
}

/// The saved level for live dictation.
pub fn stored_level(db: &Db) -> Result<Level, AppError> {
    if let Some(value) = db
        .get_meta(SPEECH_POLISH_LEVEL)?
        .and_then(|v| v.parse::<u8>().ok())
    {
        return Ok(Level::from_number(value));
    }
    Ok(Level::DEFAULT)
}

fn plain_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|ch| ch.is_alphanumeric())
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|word| !word.is_empty())
        .collect()
}

/// Share of the heard words that the reply keeps in order, ignoring case and punctuation.
pub fn kept_share(heard: &str, reply: &str) -> f32 {
    let a = plain_words(heard);
    let b = plain_words(reply);
    if a.is_empty() {
        return 1.0;
    }
    let mut row = vec![0_usize; b.len() + 1];
    for word in &a {
        let mut diagonal = 0;
        for (j, other) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if word == other {
                diagonal + 1
            } else {
                row[j + 1].max(row[j])
            };
            diagonal = above;
        }
    }
    row[b.len()] as f32 / a.len() as f32
}

/// Share of the words a reply drops that are said again in the reply or in `later`. A
/// correction drops the words of the first try, which mostly come back reworded.
fn restated_share(heard: &str, reply: &str, later: &str) -> f32 {
    let mut left: Vec<String> = plain_words(reply);
    let mut dropped = Vec::new();
    for word in plain_words(heard) {
        match left.iter().position(|other| *other == word) {
            Some(at) => {
                left.remove(at);
            }
            None => dropped.push(word),
        }
    }
    if dropped.is_empty() {
        return 1.0;
    }
    let again: std::collections::HashSet<String> = plain_words(reply)
        .into_iter()
        .chain(plain_words(later))
        .collect();
    dropped.iter().filter(|word| again.contains(*word)).count() as f32 / dropped.len() as f32
}

/// Whether a reply that removed a correction's first try may replace what was heard.
fn correction_allowed(level: Level, heard: &str, reply: &str, later: &str) -> bool {
    kept_share(heard, reply) >= level.min_kept()
        || (kept_share(heard, reply) >= 0.25 && restated_share(heard, reply, later) >= 0.6)
}

/// What one improvement pass gets besides the dictated words.
#[derive(Debug, Default, Clone, Copy)]
pub struct PolishContext<'a> {
    /// Note text before and after the dictation, for the Max level.
    pub before: &'a str,
    pub after: &'a str,
    /// Remove a first try that the speaker said again (High and Max).
    pub corrections: bool,
    /// Words said right after the dictated text, which may say its end again.
    pub later: &'a str,
}

/// Lets the chat model tidy dictated text, using the note around the cursor. With
/// corrections, an empty reply means every word was said again in `later`.
pub async fn polish(
    http: &reqwest::Client,
    server: &llm::Server,
    db: &Db,
    level: Level,
    dictated: &str,
    context: PolishContext<'_>,
) -> Result<String, AppError> {
    let PolishContext {
        before,
        after,
        corrections,
        later,
    } = context;
    if level == Level::Basic || dictated.trim().is_empty() {
        return Ok(dictated.to_string());
    }
    let mut user = match level {
        Level::Context => format!(
            "<before>\n{before}\n</before>\n\n<after>\n{after}\n</after>\n\n<dictated>\n{dictated}\n</dictated>"
        ),
        _ => format!("<dictated>\n{dictated}\n</dictated>"),
    };
    let later = if corrections { later.trim() } else { "" };
    if !later.is_empty() {
        user.push_str(&format!("\n\n<later>\n{later}\n</later>"));
    }
    let mut rules = polish_rules(level, &db.get_meta(SPEECH_LANGUAGE)?.unwrap_or_default());
    if corrections {
        rules = format!("{POLISH_CORRECTIONS} {rules}");
    }
    let raw = llm::complete(http, server, &rules, &user, POLISH_TIMEOUT).await?;
    let cleaned = llm::clean_answer(&raw, "");
    let cleaned = cleaned
        .trim()
        .trim_start_matches("<dictated>")
        .trim_end_matches("</dictated>")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    judge_reply(level, dictated, &cleaned, corrections, later)
}

/// Decides what a pass's reply turns the heard words into.
fn judge_reply(
    level: Level,
    dictated: &str,
    reply: &str,
    corrections: bool,
    later: &str,
) -> Result<String, AppError> {
    let reply = reply.trim();
    if corrections && !later.is_empty() && (reply == RESTATED || reply.is_empty()) {
        // Everything was said again later: only allowed when most words do come back.
        return Ok(if restated_share(dictated, "", later) >= 0.6 {
            String::new()
        } else {
            dictated.to_string()
        });
    }
    if reply.is_empty() || reply == RESTATED {
        return Err(AppError::Message("the model returned no text".into()));
    }
    let allowed = if corrections {
        correction_allowed(level, dictated, reply, later)
    } else {
        kept_share(dictated, reply) >= level.min_kept()
    };
    Ok(if allowed {
        reply.to_string()
    } else {
        dictated.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_that_rewrites_too_much_keeps_the_words_as_heard() {
        assert!((kept_share("mä meen kauppaan", "Mä meen kauppaan.") - 1.0).abs() < 1e-6);
        let heard = "no niin elikkä me sovittiin et julkasu siirretään";
        let light = "No niin, elikkä me sovittiin, et julkaisu siirretään.";
        assert!(kept_share(heard, light) >= Level::Improved.min_kept());
        let rewrite = "Sovimme, että julkaisua siirretään.";
        assert!(kept_share(heard, rewrite) < Level::Improved.min_kept());
        assert!(kept_share("", "anything") >= 1.0);
    }

    #[test]
    fn a_restarted_sentence_may_drop_its_first_try() {
        let heard = "What is the worst? Time. When is the worst time?";
        let fixed = "When is the worst time?";
        // Without corrections the guard keeps the words as heard at the quick level.
        assert_eq!(
            judge_reply(Level::Improved, heard, fixed, false, "").unwrap(),
            heard
        );
        assert_eq!(
            judge_reply(Level::Improved, heard, fixed, true, "").unwrap(),
            fixed
        );
        // Dropping words that are never said again is still refused.
        let invented = "When?";
        assert_eq!(
            judge_reply(Level::Proofread, heard, invented, true, "").unwrap(),
            heard
        );
    }

    #[test]
    fn a_paragraph_said_again_after_it_is_removed() {
        let heard = "What is the worst? Time.";
        let later = "When is the worst time?";
        assert_eq!(
            judge_reply(Level::Proofread, heard, "[restated]", true, later).unwrap(),
            ""
        );
        // The end said again is removed; the rest stays.
        let paragraph = "We ship on Friday. What is the worst? Time.";
        assert_eq!(
            judge_reply(
                Level::Proofread,
                paragraph,
                "We ship on Friday.",
                true,
                later
            )
            .unwrap(),
            "We ship on Friday."
        );
        // Something else said later is no reason to remove the paragraph.
        assert_eq!(
            judge_reply(
                Level::Proofread,
                heard,
                "[restated]",
                true,
                "Buy milk tomorrow."
            )
            .unwrap(),
            heard
        );
        // Without corrections an empty reply is an error, as before.
        assert!(judge_reply(Level::Proofread, heard, "", false, later).is_err());
    }

    #[test]
    fn a_chosen_language_is_named_to_the_chat_model() {
        let detect = polish_rules(Level::Improved, "");
        assert!(detect.starts_with(POLISH_IMPROVED) && detect.ends_with(POLISH_COMMON));
        assert!(!detect.contains("The text is in"));
        let finnish = polish_rules(Level::Proofread, "fi");
        assert!(finnish.starts_with(POLISH_PROOF));
        assert!(finnish.contains("The text is in Finnish; use correct Finnish words"));
        assert!(polish_rules(Level::Context, "ja").contains("the language with code \"ja\""));
    }

    #[test]
    fn the_saved_level_is_used_and_an_unknown_one_is_the_default() {
        let db = Db::open_memory().unwrap();
        assert_eq!(stored_level(&db).unwrap(), Level::Improved);
        db.set_meta(SPEECH_POLISH_LEVEL, "4").unwrap();
        assert_eq!(stored_level(&db).unwrap(), Level::Context);
        assert_eq!(Level::from_number(9), Level::Improved);
    }
}
