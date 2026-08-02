//! Prints the VST3 instruments installed on this machine.
//!
//! Loading real third-party plugins cannot be done from a unit test — it needs
//! whatever happens to be installed — so this is the manual counterpart to
//! `scan`'s tests. Run with `cargo run --example scan`.

fn main() {
    let found = chord_composer_lib::vst3::scan::scan();

    println!("{} instrument(s)\n", found.len());
    for info in &found {
        println!("{}", info.name);
        println!("  class id : {}", info.class_id);
        println!("  vendor   : {}", info.vendor);
        println!("  version  : {}", info.version);
        println!("  category : {}", info.sub_categories);
        println!("  path     : {}", info.path);
        println!();
    }
}
