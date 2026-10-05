// Development inspector using upstream webc, not a browser container parser.
use sha2::{Digest, Sha256};
use serde_json::{json, Value};
fn pin(raw: &[u8], data: &[u8]) -> Value {
    let base = raw.as_ptr() as usize;
    let ptr = data.as_ptr() as usize;
    let offset = if data.is_empty() {0} else if ptr >= base && ptr + data.len() <= base + raw.len() {ptr-base} else {raw.windows(data.len()).position(|w| w == data).expect("content is not stored verbatim")};
    json!({"offset":offset,"length":data.len(),"sha256":format!("{:x}",Sha256::digest(data))})
}
fn walk(raw: &[u8], volume: &webc::Volume, root: &str, out: &mut serde_json::Map<String,Value>) {
    for (name,_,kind) in volume.read_dir(root).expect("read directory") {
        let path = format!("{}/{}",root.trim_end_matches('/'),name);
        match kind {
            webc::Metadata::Dir {..} => walk(raw,volume,&path,out),
            webc::Metadata::File {..} => { let (data,_) = volume.read_file(path.as_str()).unwrap(); out.insert(path,pin(raw,&data)); },
        }
    }
}
fn main() {
    let path = std::env::args().nth(1).expect("file");
    let raw = bytes::Bytes::from(std::fs::read(path).unwrap());
    let version = webc::detect(raw.as_ref()).unwrap();
    let container = webc::Container::from_bytes_and_version(raw.clone(),version).unwrap();
    let atoms: serde_json::Map<String,Value> = container.atoms().into_iter().map(|(name,data)| (name,pin(&raw,&data))).collect();
    let mut volumes = serde_json::Map::new();
    for (name,volume) in container.volumes() { let mut files = serde_json::Map::new(); walk(&raw,&volume,"/",&mut files); volumes.insert(name,Value::Object(files)); }
    println!("{}",json!({"sha256":format!("{:x}",Sha256::digest(&raw)),"length":raw.len(),"manifest":container.manifest(),"atoms":atoms,"volumes":volumes}));
}
