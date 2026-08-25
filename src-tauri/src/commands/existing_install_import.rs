use crate::core::{error::AppError, existing_install_import};

#[tauri::command]
pub async fn get_existing_installation_import_status(
) -> Result<existing_install_import::ExistingInstallationImportStatus, AppError> {
    tauri::async_runtime::spawn_blocking(existing_install_import::status)
        .await?
        .map_err(AppError::io)
}

#[tauri::command]
pub async fn choose_existing_installation_import(
    choice: String,
    confirmed_source: Option<String>,
) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        existing_install_import::choose(&choice, confirmed_source.as_deref())
    })
    .await?
    .map_err(AppError::io)
}
