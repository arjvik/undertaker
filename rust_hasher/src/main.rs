use num::{bigint::RandBigInt, BigUint, Num};
use std::env;
use std::ops::Range;
use rand::thread_rng;
use blake2s_simd::{many::{hash_many, HashManyJob}, Params};

fn main() {
    let args = env::args().collect::<Vec<String>>();
    let t: BigUint = BigUint::from_str_radix(format!("{:0<64}", "00000000abc").as_str(), 16).unwrap();
    const BATCH: u32 = 256;
    let PREFIX: &str = args[1].as_str();
    let SUFFIX: &str = args[2].as_str();
    let mut nonce: BigUint = thread_rng().gen_biguint(255) + (BigUint::from(1u32) << 255);
    // let mut nonce: BigUint = BigUint::from(0u32);
    let mut params = Params::new();
    params.hash_length(32);
    const LOOPS: Range<u32> = 0..BATCH;
    let mut hashes: Vec<BigUint>;// = Vec::new();
    let mut found: Vec<bool> = Vec::new();
    // let mut queries: u64 = 0;
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
        // queries += BATCH as u64;
    }
    let idx = found.iter().position(|&b| b).unwrap();
    // println!("Nonce: {:0>64}\nHash:  {:0>64}\nQueries: {}", (nonce + idx).to_str_radix(16), hashes[idx].to_str_radix(16), queries);
    println!("{}{:0>64}{}", PREFIX, (nonce + idx).to_str_radix(16), SUFFIX);
    
}