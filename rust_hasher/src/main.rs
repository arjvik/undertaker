use num::{bigint::RandBigInt, BigUint, Num};
use std::ops::Range;
use rand::thread_rng;
use blake2s_simd::{many::{hash_many, HashManyJob}, Params};

fn main() {
    let t: BigUint = BigUint::from_str_radix(format!("{:0<64}", "000000abc").as_str(), 16).unwrap();
    const BATCH: u32 = 256;
    const PREFIX: &str = "{\"T\":\"00000000abc00000000000000000000000000000000000000000000000000000\",\"created\":1677205104,\"miner\":\"Undertaker (GitHub: arjvik/undertaker, commit ee374f0)\",\"nonce\":\"";
    const SUFFIX: &str = "\",\"note\":\"Block 9 (student mined)\",\"previd\":\"0000000077905b7e3664183c7f1e336b8d0eef1d1569ad6d414e398d2d10bf98\",\"studentids\":[\"arjvik\",\"aalinur\"],\"txids\":[\"942f41dc862ea67052c72df547d43de2edfea08ba007c7e2d0c73c593ed145c6\"],\"type\":\"block\"}";
    let mut nonce: BigUint = thread_rng().gen_biguint(255) + (BigUint::from(1u32) << 255);
    let mut params = Params::new();
    params.hash_length(32);
    const LOOPS: Range<u32> = 0..BATCH;
    let mut hashes: Vec<BigUint> = Vec::new();
    let mut found: Vec<bool> = Vec::new();
    while !found.iter_mut().any(|b| *b) {
        nonce += BATCH;
        let mut binding: Vec<Vec<u8>> = LOOPS
                .into_iter()
                .map(|i| nonce.clone() + i)
                .map(|n: BigUint| n.to_str_radix(16))
                .map(|s| String::new() + PREFIX + &s[..] + &SUFFIX)
                .map(|s| s.into_bytes())
                .collect();
        let mut jobs: Vec<HashManyJob> = binding
                .iter_mut()
                .map(|s| HashManyJob::new(&params, s))
                .collect();
        hash_many(jobs.iter_mut());
        hashes = jobs
                .iter_mut()
                .map(|j| j.to_hash().as_array().clone())
                .map(|h| BigUint::from_bytes_be(&h))
                .collect();
        found = hashes.iter()
                      .map(|h| h < &t)
                      .collect();
    }
    let idx = found.iter().position(|&b| b).unwrap();
    println!("Nonce: {}\nHash: {:0>64}", nonce + idx, hashes[idx].to_str_radix(16));
    
}