fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = "../../packages/runner-protocol/proto";
    let file = format!("{root}/sling/runner/v1/runner.proto");
    println!("cargo:rerun-if-changed={file}");
    prost_build::Config::new()
        .protoc_executable(protoc_bin_vendored::protoc_bin_path()?)
        .compile_protos(&[file], &[root])?;
    Ok(())
}
