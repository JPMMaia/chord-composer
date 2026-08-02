//! Renders a note through a real installed plugin and reports the peak level.
//!
//! The COM path — instantiate, set up, activate, feed events, `process` — cannot
//! be exercised by a unit test, because it needs an actual plugin. This is the
//! deterministic version of "does it make sound": no audio device, no listening,
//! just whether non-zero samples come back.
//!
//! - `cargo run --example render` — the first installed instrument.
//! - `cargo run --example render -- <class id>` — a specific installed one.
//! - `cargo run --example render -- --path <file.vst3>` — a module that is not
//!   installed, which is how the bundled test synth is exercised.

use chord_composer_lib::vst3::{module::Module, plugin::Plugin, scan};

const SAMPLE_RATE: f64 = 48_000.0;
const BLOCK: usize = 512;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let (path, class_id, name, vendor) = if args.first().map(String::as_str) == Some("--path") {
        let Some(path) = args.get(1) else {
            eprintln!("--path needs a file");
            std::process::exit(1);
        };
        let module = match Module::load(path.as_ref()) {
            Ok(m) => m,
            Err(err) => {
                eprintln!("load failed: {err}");
                std::process::exit(1);
            }
        };
        let Some(info) = module.classes().into_iter().next() else {
            eprintln!("{path}: no audio plug-in classes");
            std::process::exit(1);
        };
        (info.path, info.class_id, info.name, info.vendor)
    } else {
        let wanted = args.first();
        let installed = scan::scan();
        let Some(info) = installed
            .into_iter()
            .find(|p| wanted.is_none_or(|w| &p.class_id == w))
        else {
            eprintln!("no matching plugin installed");
            std::process::exit(1);
        };
        (info.path, info.class_id, info.name, info.vendor)
    };

    println!("plugin  : {name} ({vendor})");
    println!("class id: {class_id}");

    let mut plugin = match Plugin::load(path.as_ref(), &class_id, SAMPLE_RATE, BLOCK) {
        Ok(p) => p,
        Err(err) => {
            eprintln!("load failed: {err}");
            std::process::exit(1);
        }
    };

    println!("{:#?}", plugin.diagnostics());

    // Middle C, full velocity, starting immediately and held for two seconds.
    plugin
        .scheduler
        .schedule_note(60, 100, 0, (SAMPLE_RATE * 2.0) as i64);

    let mut out = vec![0.0f32; BLOCK * 2];
    let mut peak = 0.0f32;
    let mut first_sound_at: Option<f64> = None;

    // Four seconds: long enough for a slow attack and the release afterwards.
    let blocks = (SAMPLE_RATE * 4.0 / BLOCK as f64) as usize;
    for block in 0..blocks {
        out.fill(0.0);
        plugin.process_into(&mut out, BLOCK, (block * BLOCK) as i64);

        let block_peak = out.iter().fold(0.0f32, |a, s| a.max(s.abs()));
        peak = peak.max(block_peak);

        if first_sound_at.is_none() && block_peak > 1e-4 {
            first_sound_at = Some((block * BLOCK) as f64 / SAMPLE_RATE);
        }
    }

    println!("peak    : {peak:.6}");
    match first_sound_at {
        Some(t) => println!("sound at: {t:.3}s"),
        None => println!("sound at: never — the plugin rendered silence"),
    }

    if peak <= 1e-4 {
        eprintln!("\nFAIL: no audio came back.");
        std::process::exit(2);
    }
    println!("\nOK: the plugin produced audio.");
}
