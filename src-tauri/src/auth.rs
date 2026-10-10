use keyring::Entry;

use crate::error::AppError;
use crate::notes::{Db, KEYCHAIN_IMPORTED};

const SERVICE: &str = "app.memose";
const ACCOUNT: &str = "memos-token";

pub fn import_legacy_token(db: &Db) -> Result<(), AppError> {
    if db.get_meta(KEYCHAIN_IMPORTED)?.as_deref() == Some("1") {
        return Ok(());
    }
    match read_legacy() {
        Ok(Some(token)) if db.access_token()?.is_none() => db.set_access_token(&token)?,
        Ok(_) => {}
        Err(err) => eprintln!("memose: keychain token was not copied ({err})"),
    }
    db.set_meta(KEYCHAIN_IMPORTED, "1")
}

fn read_legacy() -> Result<Option<String>, AppError> {
    let entry = Entry::new(SERVICE, ACCOUNT)?;
    match entry.get_password() {
        Ok(token) if !token.is_empty() => Ok(Some(token)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.into()),
    }
}
