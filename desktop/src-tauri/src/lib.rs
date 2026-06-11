// Десктоп-бэкенд «Проявки»: локальный апскейл через sidecar
// realesrgan-ncnn-vulkan (GPU/Vulkan/MoltenVK). Тот же UI, что и в вебе,
// общается с этим бэкендом через команды create_job / job_status / save_result.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    status: String, // queued | processing | done | error
    progress: i32,
    error: Option<String>,
    original_path: Option<String>,
    result_path: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Default)]
struct Jobs(Mutex<HashMap<String, Job>>);

// ключ модели UI -> имя модели ncnn (в комплекте только эти две)
fn model_name(key: &str) -> Option<&'static str> {
    match key {
        "soft" | "detail" => Some("realesrgan-x4plus"),
        "art" => Some("realesrgan-x4plus-anime"),
        _ => None,
    }
}

fn work_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_cache_dir()
        .unwrap_or(std::env::temp_dir())
        .join("jobs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[tauri::command]
fn meta(app: tauri::AppHandle) -> serde_json::Value {
    let models_dir = app
        .path()
        .resource_dir()
        .map(|d| d.join("resources").join("models"))
        .unwrap_or_default();
    let mut models = vec![];
    for (key, file) in [("soft", "realesrgan-x4plus"), ("art", "realesrgan-x4plus-anime")] {
        if models_dir.join(format!("{file}.param")).exists() {
            models.push(key);
        }
    }
    serde_json::json!({
        "engine": "ncnn-local",
        "models": models,
        "maxUploadMb": 30
    })
}

#[tauri::command]
async fn create_job(
    app: tauri::AppHandle,
    jobs: State<'_, Jobs>,
    bytes: Vec<u8>,
    filename: String,
    scale: i32,
    model: String,
) -> Result<String, String> {
    let name = model_name(&model).ok_or("That option isn’t available")?;
    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();

    let dir = work_dir(&app).join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let in_ext = if filename.to_lowercase().ends_with(".png") { "png" } else { "jpg" };
    let input = dir.join(format!("input.{in_ext}"));
    let upscaled = dir.join("upscaled.png");
    let result = dir.join(format!("result.{in_ext}"));
    std::fs::write(&input, &bytes).map_err(|e| e.to_string())?;

    jobs.0.lock().unwrap().insert(
        id.clone(),
        Job {
            status: "processing".into(),
            original_path: Some(input.to_string_lossy().into()),
            ..Default::default()
        },
    );

    let app2 = app.clone();
    let id2 = id.clone();
    let models_dir = app
        .path()
        .resource_dir()
        .map(|d| d.join("resources").join("models"))
        .unwrap_or_default();

    tauri::async_runtime::spawn(async move {
        let res = run_upscale(
            &app2, &input, &upscaled, name, &models_dir, scale, &result, in_ext, &id2,
        )
        .await;
        let jobs = app2.state::<Jobs>();
        let mut map = jobs.0.lock().unwrap();
        if let Some(job) = map.get_mut(&id2) {
            match res {
                Ok((w, h)) => {
                    job.status = "done".into();
                    job.progress = 100;
                    job.result_path = Some(result.to_string_lossy().into());
                    job.width = Some(w);
                    job.height = Some(h);
                }
                Err(e) => {
                    job.status = "error".into();
                    job.error = Some(e);
                }
            }
        }
    });

    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn run_upscale(
    app: &tauri::AppHandle,
    input: &PathBuf,
    upscaled: &PathBuf,
    model: &str,
    models_dir: &PathBuf,
    scale: i32,
    result: &PathBuf,
    out_ext: &str,
    id: &str,
) -> Result<(u32, u32), String> {
    let sidecar = app
        .shell()
        .sidecar("realesrgan-ncnn-vulkan")
        .map_err(|e| e.to_string())?
        .args([
            "-i", &input.to_string_lossy(),
            "-o", &upscaled.to_string_lossy(),
            "-n", model,
            "-s", "4",
            "-m", &models_dir.to_string_lossy(),
        ]);

    let (mut rx, _child) = sidecar.spawn().map_err(|e| e.to_string())?;
    while let Some(event) = rx.recv().await {
        if let CommandEvent::Stderr(line) = event {
            let text = String::from_utf8_lossy(&line);
            if let Some(p) = parse_percent(&text) {
                update_progress(app, id, (p as f32 * 0.95) as i32);
            }
        }
    }

    if !upscaled.exists() {
        return Err("Processing failed — please try again".into());
    }

    // scale 2 = апскейл 4х + даунскейл вдвое; result в исходном формате
    let mut img = image::open(upscaled).map_err(|e| e.to_string())?;
    if scale == 2 {
        img = img.resize(img.width() / 2, img.height() / 2, image::imageops::FilterType::Lanczos3);
    }
    if out_ext == "png" {
        img.save(result).map_err(|e| e.to_string())?;
    } else {
        img.to_rgb8()
            .save_with_format(result, image::ImageFormat::Jpeg)
            .map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(upscaled);
    Ok((img.width(), img.height()))
}

fn parse_percent(s: &str) -> Option<u32> {
    let idx = s.find('%')?;
    let head = &s[..idx];
    let start = head.rfind(|c: char| !(c.is_ascii_digit() || c == '.' || c == ',')).map(|i| i + 1).unwrap_or(0);
    head[start..].split(['.', ',']).next()?.parse().ok()
}

fn update_progress(app: &tauri::AppHandle, id: &str, p: i32) {
    let jobs = app.state::<Jobs>();
    let mut map = jobs.0.lock().unwrap();
    if let Some(job) = map.get_mut(id) {
        job.progress = job.progress.max(p.min(99));
    }
    let _ = app.emit("job-progress", (id, p));
}

#[tauri::command]
fn job_status(jobs: State<'_, Jobs>, id: String) -> Result<Job, String> {
    jobs.0
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "This job is no longer available".into())
}

#[tauri::command]
fn read_image(jobs: State<'_, Jobs>, id: String, which: String) -> Result<Vec<u8>, String> {
    let map = jobs.0.lock().unwrap();
    let job = map.get(&id).ok_or("No such job")?;
    let path = match which.as_str() {
        "original" => job.original_path.clone(),
        _ => job.result_path.clone(),
    }
    .ok_or("File isn’t ready yet")?;
    std::fs::read(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_result(app: tauri::AppHandle, jobs: State<'_, Jobs>, id: String) -> Result<(), String> {
    let path = {
        let map = jobs.0.lock().unwrap();
        let job = map.get(&id).ok_or("No such job")?;
        job.result_path.clone().ok_or("Result isn’t ready yet")?
    };
    let src = PathBuf::from(&path);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_string();

    use tauri_plugin_dialog::DialogExt;
    let dest = app
        .dialog()
        .file()
        .set_file_name(format!("upscaled.{ext}"))
        .blocking_save_file();

    if let Some(dest) = dest {
        let dest_path = dest.into_path().map_err(|e| e.to_string())?;
        std::fs::copy(&src, &dest_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Jobs::default())
        .setup(|app| {
            // Интеграционный самотест бэкенда без GUI:
            // PROYAVKA_SELFTEST=<input.jpg> прогоняет реальный пайплайн и выходит.
            if let Ok(input) = std::env::var("PROYAVKA_SELFTEST") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let dir = std::env::temp_dir().join("proyavka-selftest");
                    let _ = std::fs::create_dir_all(&dir);
                    let up = dir.join("upscaled.png");
                    let out = dir.join("result.jpg");
                    let models = handle
                        .path()
                        .resource_dir()
                        .map(|d| d.join("resources").join("models"))
                        .unwrap_or_default();
                    match run_upscale(
                        &handle, &PathBuf::from(&input), &up, "realesrgan-x4plus",
                        &models, 2, &out, "jpg", "selftest",
                    )
                    .await
                    {
                        Ok((w, h)) => println!("SELFTEST OK {}x{} -> {}", w, h, out.display()),
                        Err(e) => println!("SELFTEST FAIL: {e}"),
                    }
                    std::process::exit(0);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            meta,
            create_job,
            job_status,
            read_image,
            save_result
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
