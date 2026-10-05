// Generated from pinned WebC containers by scripts/wasi-artifacts (upstream webc 10.0.1).
// Offsets are valid only after the complete container SHA-256 and length match.
export interface ArtifactSlice { offset:number; length:number; sha256:string }
export interface ArtifactPin {
  sha256:string; length:number; atoms:Record<string,ArtifactSlice>;
  commands:Record<string,string>; resources:Record<string,ArtifactSlice>;
  upstream:Record<string,unknown>;
}
export const ARTIFACT_PINS: Record<string,ArtifactPin> = {
  "zstd": {
    "sha256": "a969524aea789aa933186008c12f4ff3031e07292b3ca9dc500941c3fa837a9d",
    "length": 950591,
    "atoms": {
      "zstd": {
        "offset": 0,
        "length": 950591,
        "sha256": "a969524aea789aa933186008c12f4ff3031e07292b3ca9dc500941c3fa837a9d"
      }
    },
    "commands": {
      "zstd": "zstd"
    },
    "resources": {},
    "upstream": {
      "name": "facebook/zstd",
      "version": "1.4.8",
      "repository": "https://github.com/facebook/zstd",
      "license": "BSD-3-Clause OR GPL-2.0-only",
      "target": "wasm32-wasip1",
      "compiler": "wasi-sdk 24.0",
      "source_sha256": "f176f0626cb797022fbf257c3c644d71c1c747bb74c32201f9203654da35e9fa",
      "limitations": [
        "single thread",
        "no gzip/xz/lz4 passthrough",
        "no ownership copying"
      ],
      "build": "scripts/wasi-artifacts/build-zstd.sh",
      "cwd": "scripts/wasi-artifacts/sdk-cwd.c; one root preopen and authoritative PWD"
    }
  },
  "cowsay": {
    "sha256": "a2e3295a5dd39bdc39e23c6e9f88187af25e518cc8dbfb1a8fffeda7a2f2d12f",
    "length": 432352,
    "atoms": {
      "cowsay": {
        "offset": 0,
        "length": 432352,
        "sha256": "a2e3295a5dd39bdc39e23c6e9f88187af25e518cc8dbfb1a8fffeda7a2f2d12f"
      }
    },
    "commands": {
      "cowsay": "cowsay",
      "cowthink": "cowsay"
    },
    "resources": {},
    "upstream": {
      "name": "wapm-packages/cowsay",
      "version": "0.3.0-fg1",
      "repository": "https://github.com/wapm-packages/cowsay",
      "source_commit": "907f67128f3ed332c69d5f1c181d72df41823c05",
      "source_sha256": "5e841c532277cd5a6d850d234b21c1841438b32c38b80791a67391e7c22d6126",
      "compiler": "rustc 1.99.0 (b940084d7 2026-09-28)",
      "target": "wasm32-wasip1",
      "build": "scripts/wasi-artifacts/build-cowsay.sh",
      "dependency_lock": "scripts/wasi-artifacts/cowsay.lock",
      "license": "MIT; embedded cow artwork Artistic or GPL per COW-ASSETS-LICENSE",
      "patches": [
        "native default tongue uses two spaces",
        "exclude nine cowfiles with unknown artwork licenses, matching Debian distribution"
      ],
      "limitations": [
        "existing Rust port; multiline/wrapping/custom cowfile parity not yet accepted"
      ]
    }
  },
  "fortune": {
    "sha256": "59c02fd68e98da2c445ee8e97098aff1038ef7aa237601b2a099e734a99ef49d",
    "length": 2416516,
    "atoms": {
      "fortune": {
        "length": 2413765,
        "offset": 1159,
        "sha256": "b8298c6a2615a36e4426ad4982de0a29da7a2b2da2675a49c13749e0d1aeaaf7"
      }
    },
    "commands": {
      "fortune": "fortune"
    },
    "resources": {
      "/usr/share/doc/shiro/fortune/README.md": {
        "length": 1422,
        "offset": 2415094,
        "sha256": "0e10a9562165b2563516439b02350daccf73c7d80b0ab5176560f438a75d56f4"
      }
    },
    "upstream": {
      "description": "fortune is a program that displays a pseudorandom message from a database of quotations",
      "name": "fortune",
      "readme": {
        "path": "/README.md",
        "volume": "metadata"
      },
      "repository": "https://github.com/wapm-packages/fortune",
      "version": "0.2.0"
    }
  },
  "lolcat": {
    "sha256": "b867558fee3734d9c77a9bdc38abcfc0793bfbad0e901639a192641d5a34bdb7",
    "length": 2131185,
    "atoms": {
      "lolcat": {
        "length": 2128923,
        "offset": 1085,
        "sha256": "8b9b52ca8bc82654bc43308a45dde7b2ad598649fa67564beb5f8ba41a06867c"
      }
    },
    "commands": {
      "lolcat": "lolcat"
    },
    "resources": {
      "/usr/share/doc/shiro/lolcat/README.md": {
        "length": 1007,
        "offset": 2130178,
        "sha256": "400c13df7a5087a46d6dae8f33170d75bec918ec3b866b17c9edf1bf88908d38"
      }
    },
    "upstream": {
      "description": "Rainbows and unicorns!",
      "name": "lolcat",
      "readme": {
        "path": "/README.md",
        "volume": "metadata"
      },
      "repository": "https://github.com/wapm-packages/lolcat",
      "version": "0.2.0"
    }
  },
  "figlet": {
    "sha256": "9fc959de4ce58c6c2bc11b8cbaa0a1a471bcde84a0fe341cffc25a42251d91c9",
    "length": 769349,
    "atoms": {
      "chkfont": {
        "length": 75658,
        "offset": 1472,
        "sha256": "a8fcad775e5ab5739c3d6f723cc8121b56fea9c1078d2b1bb1c2e0216d599062"
      },
      "figlet": {
        "length": 107944,
        "offset": 77130,
        "sha256": "cfb54deb829a5c910544ea7fe25c576c921e9a62f7181cae0f0ccd16432ace65"
      }
    },
    "commands": {
      "chkfont": "chkfont",
      "figlet": "figlet"
    },
    "resources": {
      "/fonts/646-ca.flc": {
        "length": 5217,
        "offset": 189425,
        "sha256": "4f43f9bbac7d32499fd068c2413dff6a92fccf1bcc6479f77bc5d1b6900cb1a2"
      },
      "/fonts/646-ca2.flc": {
        "length": 5201,
        "offset": 194642,
        "sha256": "409850474caf3c073b707af8bdfb5e9cd9449ff4de1826891bf72fa93f7cd065"
      },
      "/fonts/646-cn.flc": {
        "length": 4984,
        "offset": 199843,
        "sha256": "ac0ebb8a4ba21cfe0827d9199bee1358f3db9b64f743a1e68b25407e8103698e"
      },
      "/fonts/646-cu.flc": {
        "length": 5054,
        "offset": 204827,
        "sha256": "ff5a31c7f7bd7839cbd0358eaeabdd0b0488bf44303bf5086b936ba510b7e847"
      },
      "/fonts/646-de.flc": {
        "length": 5121,
        "offset": 209881,
        "sha256": "27106cb2a66933e3de1e7c17a5f52c0b559e395cd841404c60ccd3f06e50b598"
      },
      "/fonts/646-dk.flc": {
        "length": 5019,
        "offset": 215002,
        "sha256": "8e1387fd4a15ac0b80dcce2c5c442b4ff59a8f72b3e6b7cad4a3b6dc381e83be"
      },
      "/fonts/646-es.flc": {
        "length": 4987,
        "offset": 220021,
        "sha256": "c4d850e140bf0e0a41ca361955201da8869ee4205caa68f69304d68dd19aacbd"
      },
      "/fonts/646-es2.flc": {
        "length": 5019,
        "offset": 225008,
        "sha256": "b16569253494da5f4d44665fe4e9e89ba48d57fe827a87a529b9c5bd1f45cb0d"
      },
      "/fonts/646-fr.flc": {
        "length": 5052,
        "offset": 230027,
        "sha256": "b8352619b4113f0b78ff2f356cbb681e32f74ad7726ee80864badbed81cbc2d4"
      },
      "/fonts/646-gb.flc": {
        "length": 4987,
        "offset": 235079,
        "sha256": "ec6ea56b817743f1d3dcdaf55fa5524a01dbbc067753306cb9edbd1c1b3a5d74"
      },
      "/fonts/646-hu.flc": {
        "length": 5143,
        "offset": 240066,
        "sha256": "124759353bdf3d1adcf369dba50f9cf15139336f57c105fc011e225817d8a9ea"
      },
      "/fonts/646-irv.flc": {
        "length": 4992,
        "offset": 245209,
        "sha256": "a8d5ab807e576dedfcc8cd9415c703edc5c41990beb61bcc87b58d4e5d600902"
      },
      "/fonts/646-it.flc": {
        "length": 5045,
        "offset": 250201,
        "sha256": "047c95d17f8320765511bd27de15567a40a9766656a8276134cf571877f4200f"
      },
      "/fonts/646-jp.flc": {
        "length": 5008,
        "offset": 255246,
        "sha256": "922544ffc2c1a043643edeed1978cc3df6f5a2de553357d454571ca64ca5d79d"
      },
      "/fonts/646-kr.flc": {
        "length": 4843,
        "offset": 260254,
        "sha256": "af4ca8cb328520ac9e0bafc987542f4b60c0bb7446aacd3a64d96621db01bf70"
      },
      "/fonts/646-no.flc": {
        "length": 5063,
        "offset": 265097,
        "sha256": "5ad84ad2486ba4bc5eedf813667be8b725a62ed59171608edce521fe13b9823c"
      },
      "/fonts/646-no2.flc": {
        "length": 5071,
        "offset": 270160,
        "sha256": "0bb3ef93bba1e6d2c6052db6c031be58a594065e25f0960b72051f6abb78b052"
      },
      "/fonts/646-pt.flc": {
        "length": 5035,
        "offset": 275231,
        "sha256": "bb99398319673a0af22537744893ed9dcd446cb31f60b4abaa53dd4818ccd9a1"
      },
      "/fonts/646-pt2.flc": {
        "length": 5037,
        "offset": 280266,
        "sha256": "902589761c4a4a1aeae4f15a604aee897260110a55caf001d90c30180bc6fe42"
      },
      "/fonts/646-se.flc": {
        "length": 5146,
        "offset": 285303,
        "sha256": "17fe5230f90f3a2dc06375b2dfe0b4fdae59b25241962d8a0a1eb0374cc3191d"
      },
      "/fonts/646-se2.flc": {
        "length": 5199,
        "offset": 290449,
        "sha256": "72c9b22815be1bd922e5be74bd83b71c49d87f3e51ba93bc3e8be11699d7be64"
      },
      "/fonts/646-yu.flc": {
        "length": 5178,
        "offset": 295648,
        "sha256": "54dfd72acc6c3296ca25af33db4524b548a896cbce1b13af5b26b21a27b3a3a9"
      },
      "/fonts/8859-2.flc": {
        "length": 10816,
        "offset": 300826,
        "sha256": "5c81eca66455c5b36853c8a66495f58636643f6ddb261083d877a7f2a48287b7"
      },
      "/fonts/8859-3.flc": {
        "length": 10498,
        "offset": 311642,
        "sha256": "a7906a91ec3a4ac7f10ec7e25966d36d98fb720f401d595de5f9f06ab1f2b2a7"
      },
      "/fonts/8859-4.flc": {
        "length": 10792,
        "offset": 322140,
        "sha256": "5bb8f1fa3fdf6df88ee3d1a17f58bdf5e336f6b665d58ea04bf7bd7bdbf259dc"
      },
      "/fonts/8859-5.flc": {
        "length": 10427,
        "offset": 332932,
        "sha256": "c1244fabad6e9b7a8053da89448c42388bbe93681742e01e74f7a22b7f08e3ed"
      },
      "/fonts/8859-7.flc": {
        "length": 10582,
        "offset": 343359,
        "sha256": "7b8d7ce8242993556958a5f95529d9d71181e6a08a070d037f157a22a77716a9"
      },
      "/fonts/8859-8.flc": {
        "length": 8553,
        "offset": 353941,
        "sha256": "4bea5cf4b048e3b7ccf704ea153edcf77d2a4c627dd8710f8f7e037afb62a171"
      },
      "/fonts/8859-9.flc": {
        "length": 10628,
        "offset": 362494,
        "sha256": "976d48dfff033c7bfedd08bc61d26f0a5fefb4c3f48f8735f454e100cf40294c"
      },
      "/fonts/banner.flf": {
        "length": 31897,
        "offset": 373122,
        "sha256": "7312d534e44dbc1d5768ea34e588a8c58aad1842faa9bd721a472db561cb2522"
      },
      "/fonts/big.flf": {
        "length": 26384,
        "offset": 405019,
        "sha256": "0065328daf2a6eb49ff274f8d27a195e7b748cb51cad992b0aa96839ccb5169d"
      },
      "/fonts/block.flf": {
        "length": 24438,
        "offset": 431403,
        "sha256": "4e9d3c11d20dd8ad25f7eef6e150670f4fdfe080a3946b4a87c32ee83a68241a"
      },
      "/fonts/bubble.flf": {
        "length": 19926,
        "offset": 455841,
        "sha256": "3e28f6fdc97e4e296de1b6fb08566c782f978c5912d6e53a957fa92ac8519c13"
      },
      "/fonts/digital.flf": {
        "length": 15139,
        "offset": 475767,
        "sha256": "dd3c2688add36c72f179778032a48a32b5c5b6fef65013bc1cb6fb6383d1bcbd"
      },
      "/fonts/frango.flc": {
        "length": 907,
        "offset": 490906,
        "sha256": "dac0a6503186a92daeeb36483543236d44551d3952c00905e870c978892df4dd"
      },
      "/fonts/hz.flc": {
        "length": 115,
        "offset": 491813,
        "sha256": "9aed49b67d75fddb410a640861d04ecb15db27930b3c8ccf024f2b6ec53b0b9b"
      },
      "/fonts/ilhebrew.flc": {
        "length": 510,
        "offset": 491928,
        "sha256": "7e3532dcab4462d75c72ee6a6be1a86849266545feaede0509d7e7c83777a26f"
      },
      "/fonts/ivrit.flf": {
        "length": 10999,
        "offset": 492438,
        "sha256": "66a274a0c907b8c0c6b4edab8024b014187443da9accf18c4f9180e9c5e5a656"
      },
      "/fonts/jis0201.flc": {
        "length": 4900,
        "offset": 503437,
        "sha256": "bd0b95f652ba3e0ca6a8e8883493038750e21fbac344b066a22a5502abc889fc"
      },
      "/fonts/koi8r.flc": {
        "length": 2048,
        "offset": 508337,
        "sha256": "90e2514936fc38b17e19f5363b1e0555bf02c56886a71287de8eb084cb48935a"
      },
      "/fonts/lean.flf": {
        "length": 28596,
        "offset": 510385,
        "sha256": "eb1e27c93b5824e913ee2b1f8f1dc2d611227b47af471b50430c4b6060995fb2"
      },
      "/fonts/mini.flf": {
        "length": 9102,
        "offset": 538981,
        "sha256": "b5d0194157641407cb0d513f9fab2abf0c4b2c436f8c238a34d718b3911fa54b"
      },
      "/fonts/mnemonic.flf": {
        "length": 83167,
        "offset": 548083,
        "sha256": "4ed37ffa2cad45e806bc4218f191a0e7a26b9111b1e4ed619be3504e521f4acd"
      },
      "/fonts/moscow.flc": {
        "length": 1045,
        "offset": 631250,
        "sha256": "e233f1bb05f82f7fae27a84e39eb46e514604828682e5ec97eecf451b89a0a85"
      },
      "/fonts/script.flf": {
        "length": 15371,
        "offset": 632295,
        "sha256": "2cdabe1d9f8951d1e4678e9dc32a6f004f7e0098351cbe388fb149a2825bd586"
      },
      "/fonts/shadow.flf": {
        "length": 13365,
        "offset": 647666,
        "sha256": "4e541014c689d8f4b2e380054bcedb2236a0c975af37b4989147e773301e342f"
      },
      "/fonts/slant.flf": {
        "length": 15520,
        "offset": 661031,
        "sha256": "776d70bf97e03e5753690bad342eb02f989b12571b018fa87dd3a67c8d16dc42"
      },
      "/fonts/small.flf": {
        "length": 12235,
        "offset": 676551,
        "sha256": "c275f3cf053af2eec87804fe60ad5cc865dbb25ea65d5cbbe09a27f332c714f0"
      },
      "/fonts/smscript.flf": {
        "length": 11274,
        "offset": 688786,
        "sha256": "72c57c300800e778185cd107f3f8447f78763057bf4b4063abea5494ee1d8ee0"
      },
      "/fonts/smshadow.flf": {
        "length": 10832,
        "offset": 700060,
        "sha256": "ed037c8cec54ba091db1de4cc5fca79f3ed093ac419f373fb1631d0ed60d0cbf"
      },
      "/fonts/smslant.flf": {
        "length": 12226,
        "offset": 710892,
        "sha256": "e12d429773ee1be01617ba0b11c368c5be90fb84770616827a6f9e385119dfc0"
      },
      "/fonts/standard.flf": {
        "length": 28521,
        "offset": 723118,
        "sha256": "42df7980ad15f73699b0272633882811e3b6b79699e67cd79f40893d2fe310c1"
      },
      "/fonts/term.flf": {
        "length": 9697,
        "offset": 751639,
        "sha256": "707266dec1d7cd48863a560c8c77c269a278bf9e97bdab77b920e8cc02770ac0"
      },
      "/fonts/upper.flc": {
        "length": 3907,
        "offset": 761336,
        "sha256": "ad4bf59c22b46fe9c555d8947f6d16d773aa3d96b88956a8bfe7d33046261a4f"
      },
      "/fonts/ushebrew.flc": {
        "length": 481,
        "offset": 765243,
        "sha256": "efb26bff5ad845ca978644dcbad238e173a10c04f1c41781ea3d91757f9ee60f"
      },
      "/fonts/uskata.flc": {
        "length": 747,
        "offset": 765724,
        "sha256": "fb3f99fcefb8310bc54f8e84f812f5651c73f74a304fd4138492ba9e3fd5e3fe"
      },
      "/fonts/utf8.flc": {
        "length": 132,
        "offset": 766471,
        "sha256": "9363d5bb4b71051242fa4a90d48b82be07f31699ecbdb62a571b906f0308d8c3"
      },
      "/usr/share/doc/shiro/figlet/README_wapm.md": {
        "length": 2617,
        "offset": 766732,
        "sha256": "2f3144cf59b7a5dde7d33f00eb0dd3db4078b53e218551b4ada05349e8e94ef0"
      }
    },
    "upstream": {
      "description": "FIGlet is a program for making large letters out of ordinary text",
      "name": "syrusakbary/figlet",
      "readme": {
        "path": "/README_wapm.md",
        "volume": "metadata"
      },
      "repository": "https://github.com/wapm-packages/figlet",
      "version": "0.0.1"
    }
  },
  "coreutils": {
    "sha256": "c53b61ad7d6f3b1231b8c38d8d9566ec649b0ba0b8da9d7952d1825886efc927",
    "length": 12964555,
    "atoms": {
      "coreutils": {
        "offset": 0,
        "length": 12964555,
        "sha256": "c53b61ad7d6f3b1231b8c38d8d9566ec649b0ba0b8da9d7952d1825886efc927"
      }
    },
    "commands": {
      "coreutils": "coreutils"
    },
    "resources": {},
    "upstream": {
      "name": "uutils/coreutils",
      "version": "a6d1eb3835c0f808fa9678e4551df7377bcab8d3",
      "repository": "https://github.com/uutils/coreutils",
      "source": "https://github.com/uutils/coreutils/tree/a6d1eb3835c0f808fa9678e4551df7377bcab8d3",
      "license": "MIT",
      "build_target": "wasm32-wasip1",
      "build_features": "feat_wasm",
      "build_metadata": "https://uutils.org/wasm/version.js"
    }
  },
  "grep": {
    "sha256": "42a2dd5452990c94a51036cfb5eb9574899beccb5ce8f83f75995f7ac5e0e1ca",
    "length": 364536,
    "atoms": {
      "grep": {
        "length": 363321,
        "offset": 1077,
        "sha256": "288bf423541bbe13e657f45c9101ce6df489a047b1dac2390ef8e4f454740260"
      }
    },
    "commands": {
      "grep": "grep"
    },
    "resources": {},
    "upstream": {}
  },
  "sed": {
    "sha256": "3fc12256be87f6b8b7810d68d642359a6220f63b39a2ea6ef7a2bb6d79ec1393",
    "length": 262523,
    "atoms": {
      "sed": {
        "length": 261314,
        "offset": 1071,
        "sha256": "1b1905e9252987599139cb7a04b04e846472438b5821a57eea0c9a15fd0189c1"
      }
    },
    "commands": {
      "sed": "sed"
    },
    "resources": {},
    "upstream": {}
  },
  "jq": {
    "sha256": "162db948e4432c35849670c36ab09127880d2b808c63fd796207d0e25b11d552",
    "length": 1535250,
    "atoms": {
      "jq": {
        "offset": 0,
        "length": 1535250,
        "sha256": "162db948e4432c35849670c36ab09127880d2b808c63fd796207d0e25b11d552"
      }
    },
    "commands": {
      "jq": "jq"
    },
    "resources": {},
    "upstream": {
      "name": "jqlang/jq",
      "version": "1.8.2",
      "repository": "https://github.com/jqlang/jq",
      "source_sha256": "71b8d6e8f5fe81f6c6d0d110e3892251f6ce76ed095abd315e26e6e1193af3af",
      "target": "wasm32-wasip1",
      "compiler": "wasi-sdk 27.0",
      "license": "MIT and included component notices; bundled Oniguruma BSD-2-Clause",
      "build": "scripts/wasi-artifacts/build-jq.sh",
      "security": "upstream 1.8.2 fixes; GNU feature declarations select secure WASI entropy; no custom parser/regex patches",
      "cwd": "scripts/wasi-artifacts/sdk-cwd.c",
      "limitations": [
        "single-thread CLI",
        "C/C.UTF-8 locales from wasi-libc",
        "no shell subprocess API"
      ]
    }
  },
  "quickjs": {
    "sha256": "430237aeffc912f4cd0981eb03ebad42a71d6b62781bd0c01903cae7d21b5733",
    "length": 2565315,
    "atoms": {
      "quickjs": {
        "length": 2562768,
        "offset": 1324,
        "sha256": "6f62a6bc5c8f8e3e12a54e2ecbc5674ccfe1c75f91d8e4dd6ebb3fec422a4d6c"
      }
    },
    "commands": {
      "qjs": "quickjs",
      "quickjs": "quickjs"
    },
    "resources": {
      "/usr/share/doc/shiro/quickjs/README.md": {
        "length": 1053,
        "offset": 2564262,
        "sha256": "d286de841510415f4194f1416ecaa486653c2f844af6778f3b424ff7beb7a2cb"
      }
    },
    "upstream": {
      "description": "QuickJS is a small and embeddable JavaScript engine. It supports the ES2019 specification including modules, asynchronous generators and proxies.",
      "homepage": "https://bellard.org/quickjs/",
      "name": "quickjs",
      "readme": {
        "path": "/README.md",
        "volume": "metadata"
      },
      "repository": "https://github.com/saghul/wasi-lab",
      "version": "0.0.3"
    }
  },
  "lua": {
    "sha256": "0c4b3ce2fd473db00ec01dd08eef759c2fee91ee564c8c6a229280d08be7ffb1",
    "length": 646508,
    "atoms": {
      "lua": {
        "offset": 0,
        "length": 646508,
        "sha256": "0c4b3ce2fd473db00ec01dd08eef759c2fee91ee564c8c6a229280d08be7ffb1"
      }
    },
    "commands": {
      "lua": "lua"
    },
    "resources": {},
    "upstream": {
      "name": "Lua",
      "version": "5.3.6",
      "repository": "https://www.lua.org/",
      "source": "https://www.lua.org/ftp/lua-5.3.6.tar.gz",
      "source_sha256": "fc5fd69bb8736323f026672b1b7235da613d7177e72558893a0bdcd320466d60",
      "target": "wasm32-wasip1",
      "compiler": "wasi-sdk 27.0; standard WebAssembly exception handling",
      "license": "MIT",
      "build": "scripts/wasi-artifacts/build-lua.sh",
      "limitations": [
        "No process shell: os.execute commands return ENOSYS; io.popen is unavailable",
        "os.clock uses WASI SDK wall-clock emulation",
        "Native shared-library loading is unavailable"
      ],
      "cwd": "scripts/wasi-artifacts/sdk-cwd.c; one root preopen and authoritative PWD"
    }
  },
  "sqlite": {
    "sha256": "435044351ae60f7fd07ff97c1cac083f1e46d43bd9bc811b249bb376ee328725",
    "length": 3575511,
    "atoms": {
      "sqlite": {
        "length": 3573220,
        "offset": 1271,
        "sha256": "992205b67977f9c7a0d1ea7568d745e055fa3015d1ab70428feed6d8da60d060"
      }
    },
    "commands": {
      "sqlite": "sqlite",
      "sqlite3": "sqlite"
    },
    "resources": {
      "/usr/share/doc/shiro/sqlite/README.md": {
        "length": 850,
        "offset": 3574661,
        "sha256": "c40ec7c3397c75dd9de4973598b565db4da3391c1a27bfeb8149ad7abe60196d"
      }
    },
    "upstream": {
      "description": "SQLite is a C-language library that implements a small, fast, self-contained, high-reliability, full-featured, SQL database engine",
      "name": "sqlite",
      "readme": {
        "path": "/README.md",
        "volume": "metadata"
      },
      "repository": "https://github.com/wapm-packages/sqlite",
      "version": "0.2.2"
    }
  },
  "viu": {
    "sha256": "b988b51ee1a395853fa402f37d69d1b379c4441b3bfca7372876098e13d4e3e9",
    "length": 3066430,
    "atoms": {
      "viu": {
        "length": 3062714,
        "offset": 1110,
        "sha256": "7e48bfd68f658ac4916c291b536e6756c173f6ba63311c67c11ffa4b111f0bff"
      }
    },
    "commands": {
      "viu": "viu"
    },
    "resources": {
      "/usr/share/doc/shiro/viu/README-wasi.md": {
        "length": 2431,
        "offset": 3063999,
        "sha256": "e68f89cf7549535a3410aacbbdd56cd41f750de801a0cc38f5587581ccc71bb9"
      }
    },
    "upstream": {
      "description": "A small command-line application to view images from the terminal",
      "name": "viu",
      "readme": {
        "path": "/README-wasi.md",
        "volume": "metadata"
      },
      "repository": "https://github.com/wapm-packages/viu",
      "version": "0.2.3"
    }
  },
  "util-linux": {
    "sha256": "3af9902aebda64554afa9b05c8726d3d183ba5c1ac57d902637e3894f3187c98",
    "length": 542738,
    "atoms": {
      "cal": {
        "length": 179456,
        "offset": 2128,
        "sha256": "dbdc64ccd978225f8bb12b01b852d66bcee54dd0ae3d5f8dce4359b2f2f108e5"
      },
      "col": {
        "length": 89315,
        "offset": 181584,
        "sha256": "2aafdd5e81a6af0bfd54070581b8ae399d7a1dd4ad174b4dd39ee121763a9a6c"
      },
      "colcrt": {
        "length": 56924,
        "offset": 270899,
        "sha256": "a5a3bb5ef3d679f84b66655696c28415da174242e3bdae99030c1682156c5d04"
      },
      "hexdump": {
        "length": 158376,
        "offset": 327823,
        "sha256": "70c05b9690fe2fd58f079f69ce2aeb27f7d327fd63d022b11897943bd33067f8"
      },
      "rev": {
        "length": 56443,
        "offset": 486199,
        "sha256": "20cd76fa23f6760d8c4e94c861b93d3e316faaf7a464851a6b8b43db8ebb5cb6"
      }
    },
    "commands": {
      "cal": "cal",
      "col": "col",
      "colcrt": "colcrt",
      "hexdump": "hexdump",
      "rev": "rev"
    },
    "resources": {},
    "upstream": {
      "description": "util-linux is a random collection of Linux utilities",
      "license": "GPL-2.0",
      "name": "syrusakbary/util-linux",
      "repository": "https://github.com/wapm-packages/util-linux",
      "version": "0.0.1"
    }
  },
  "dash": {
    "sha256": "c81513a53f11a2a23ea305fa008049d15fa1b5f52b696cedbf63554077ea5998",
    "length": 335469,
    "atoms": {
      "dash": {
        "length": 332405,
        "offset": 1157,
        "sha256": "ce4d85249665844ea9d882bda5efed67d127605735c7f5b674157804e624c9cc"
      }
    },
    "commands": {
      "dash": "dash"
    },
    "resources": {
      "/usr/coreutils/README.md": {
        "length": 1675,
        "offset": 333744,
        "sha256": "3a6ab592040d6e208599261fcd1364dae5908ed76cba4b0f65a0be0bfdf8c227"
      }
    },
    "upstream": {
      "description": "Dash is a modern POSIX-compliant implementation of /bin/sh.",
      "license": "GNU",
      "name": "sharrattj/dash",
      "version": "1.0.19"
    }
  },
  "bash": {
    "sha256": "059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1",
    "length": 1870786,
    "atoms": {
      "bash": {
        "length": 1869444,
        "offset": 1204,
        "sha256": "5b37a9f95fca50f55024b7fc37b786fa80024e55320266cb19936729d24c70ce"
      }
    },
    "commands": {
      "bash": "bash",
      "sh": "bash"
    },
    "resources": {},
    "upstream": {
      "license": "GNU"
    }
  },
  "ruby": {
    "sha256": "036c313a707ffc5b70c700a9ac44e07bb76efe2797ef7f69c8f5d38fc6a080fc",
    "length": 34328971,
    "atoms": {
      "ruby": {
        "length": 34327815,
        "offset": 1060,
        "sha256": "32cb511056cfd28f41ef1909c3bc18e2224893b63dfabbe0409968ca592f59e2"
      }
    },
    "commands": {
      "ruby": "ruby"
    },
    "resources": {},
    "upstream": {
      "description": "The Ruby Programming Language",
      "license": "MIT",
      "name": "katei/ruby",
      "repository": "https://github.com/kateinoigakukun/ruby.wasm",
      "version": "0.1.2"
    }
  },
  "php": {
    "sha256": "da8d3fcfcf02d2401787532c4af3fdaf5b680b05144a9591ca70b97131ee2f32",
    "length": 85700002,
    "atoms": {
      "php": {
        "length": 54053922,
        "offset": 1429,
        "sha256": "bf606ab43bdc8056d8f9d5f9f1b8ee52e9d657bd42f8ea9d6cae46a0e707168f"
      }
    },
    "commands": {
      "php": "php"
    },
    "resources": {
      "/etc/ssl/cacert.pem": {
        "length": 228633,
        "offset": 84824894,
        "sha256": "1bf458412568e134a4514f5e170a328d11091e071c7110955c9884ed87972ac9"
      },
      "/etc/ssl/certs/002c0b4f.0": {
        "length": 1915,
        "offset": 85053527,
        "sha256": "dcc1a6246e13880ca5b73ef547e082dd0401e4d8837b6d211be82f7be791ac65"
      },
      "/etc/ssl/certs/02265526.0": {
        "length": 1533,
        "offset": 85055442,
        "sha256": "646db48fa7794bcab4581f264ff3fad4cff7bbd24f5e8bb170d4f602b6caf828"
      },
      "/etc/ssl/certs/062cdee6.0": {
        "length": 1229,
        "offset": 85056975,
        "sha256": "6bdc59f897631af7811e3201cbc58e5999de2600ae8667454a34514eecfd8381"
      },
      "/etc/ssl/certs/064e0aa9.0": {
        "length": 1923,
        "offset": 85058204,
        "sha256": "825c67f5583131425c4e33275cc8e5c9dfd02cd190c6d71e1d335621e82965a8"
      },
      "/etc/ssl/certs/06dc52d5.0": {
        "length": 2114,
        "offset": 85060127,
        "sha256": "a0681f1a11d5c02760bcb68b61b0d332f6c197e239c4b30dc47f91a79a73282b"
      },
      "/etc/ssl/certs/08063a00.0": {
        "length": 1968,
        "offset": 85062241,
        "sha256": "40ec121c66bc70c48d5e512fa2d1d9f040c329467232f1964edd62fecb32af87"
      },
      "/etc/ssl/certs/09789157.0": {
        "length": 1424,
        "offset": 85064209,
        "sha256": "870f56d009d8aeb95b716b0e7b0020225d542c4b283b9ed896edf97428d6712e"
      },
      "/etc/ssl/certs/0a775a30.0": {
        "length": 765,
        "offset": 85065633,
        "sha256": "39238e09bb7d30e39fbf87746ceac206f7ec206cff3d73c743e3f818ca2ec54f"
      },
      "/etc/ssl/certs/0b1b94ef.0": {
        "length": 1984,
        "offset": 85066398,
        "sha256": "94e4ab21333740d7ed0f2b5007744e5cf6792c0ddf4c6bdfb3ce8333010e7306"
      },
      "/etc/ssl/certs/0b9bc432.0": {
        "length": 790,
        "offset": 85068382,
        "sha256": "a13d881e11fe6df181b53841f9fa738a2d7ca9ae7be3d53c866f722b4242b013"
      },
      "/etc/ssl/certs/0bf05006.0": {
        "length": 944,
        "offset": 85069172,
        "sha256": "b68d02ce35bd02123cf5fcd329bdd33640214715dae0442a97782a4471e9b292"
      },
      "/etc/ssl/certs/0f5dc4f3.0": {
        "length": 1915,
        "offset": 85070116,
        "sha256": "eaa3be600a842e5b603316ed14e9ae11a43003f68a8317f0f2c01a516da4e586"
      },
      "/etc/ssl/certs/0f6fa695.0": {
        "length": 1980,
        "offset": 85072031,
        "sha256": "b0bf3a444f89d8be7db120bfecaa2f94d9e49ede21f680d674c1e8d839d8a9a2"
      },
      "/etc/ssl/certs/1001acf7.0": {
        "length": 1911,
        "offset": 85074011,
        "sha256": "4195ea007a7ef8d3e2d338e8d9ff0083198e36bfa025442ddf41bb5213904fc2"
      },
      "/etc/ssl/certs/106f3e4d.0": {
        "length": 1090,
        "offset": 85075922,
        "sha256": "a0d7e56b32b767e076bd7d05ce1779dbe3656d0a02a9abe711fc79640b9f7fbe"
      },
      "/etc/ssl/certs/14bc7599.0": {
        "length": 859,
        "offset": 85077012,
        "sha256": "36e68e205b53c67c7a013894e0d5c8583063468118d1ce78ecbc2200d1dd185c"
      },
      "/etc/ssl/certs/18856ac4.0": {
        "length": 1249,
        "offset": 85077871,
        "sha256": "20828fd7b9795221c10272f9f6ed29638f6dc2614465adab1b93f2bfc484c659"
      },
      "/etc/ssl/certs/1d3472b9.0": {
        "length": 794,
        "offset": 85079120,
        "sha256": "80eeafa5039f282345129a81ace7e1c1e1d4fd826f1eb3391a4ea56f38a6e3d8"
      },
      "/etc/ssl/certs/1e08bfd1.0": {
        "length": 1931,
        "offset": 85079914,
        "sha256": "9b4282f5a402e19016c4874a52df3367eabccf05be851ad03039f777a602d30a"
      },
      "/etc/ssl/certs/1e09d511.0": {
        "length": 1367,
        "offset": 85081845,
        "sha256": "b30989fd9e45c74bf417df74d1da639d1f04d4fd0900be813a2d6a031a56c845"
      },
      "/etc/ssl/certs/244b5494.0": {
        "length": 1367,
        "offset": 85083212,
        "sha256": "d98f681c3a7dce812b90bf7c68046827f3bf5607357f1e4918c5dc813b359bf1"
      },
      "/etc/ssl/certs/2923b3f9.0": {
        "length": 1302,
        "offset": 85084579,
        "sha256": "8d390d4c54f6a4a040b04413f1f002192027c66a2a835741f78a152074584a27"
      },
      "/etc/ssl/certs/2ae6433e.0": {
        "length": 1935,
        "offset": 85085881,
        "sha256": "8adefca890c92e6d0877fdcba07655296852217da657026aea69ee547642528c"
      },
      "/etc/ssl/certs/2b349938.0": {
        "length": 1204,
        "offset": 85087816,
        "sha256": "7108110fdaf19e3e5a7ed8fa38557248e79fe78bb2e9eefe7a0bb801cbfd2db7"
      },
      "/etc/ssl/certs/32888f65.0": {
        "length": 2155,
        "offset": 85089020,
        "sha256": "677160e6297b48b87ede98ab7b4f2be55894491776f6191937ea397d01a6fb4b"
      },
      "/etc/ssl/certs/3513523f.0": {
        "length": 1338,
        "offset": 85091175,
        "sha256": "39fdcf28aeffe08d03251fccaf645e3c5de19fa4ebbafc89b4ede2a422148bab"
      },
      "/etc/ssl/certs/3bde41ac.0": {
        "length": 2167,
        "offset": 85092513,
        "sha256": "283fd555713ed4ecfcb4935f5ed5d4a9bb776236803e2910eb46e70903a3511f"
      },
      "/etc/ssl/certs/3bde41ac.1": {
        "length": 2167,
        "offset": 85094680,
        "sha256": "a618213c5dd7cbb59b3154de7241d7255333a0619cf434329becae876ce6e331"
      },
      "/etc/ssl/certs/3e44d2f7.0": {
        "length": 2204,
        "offset": 85096847,
        "sha256": "b4dc2f45b7ba821ff240be0d0c816a996cafae929b8f445b0510d9073e1aad5e"
      },
      "/etc/ssl/certs/3e45d192.0": {
        "length": 1168,
        "offset": 85099051,
        "sha256": "9dd93324ad79de9a6d595611342d38ae6ca937772c65e11da3ebf88c5a248115"
      },
      "/etc/ssl/certs/3fb36b73.0": {
        "length": 2013,
        "offset": 85100219,
        "sha256": "9848c94859f83e48defe0b25a0f4347480b56ea2bb3336fe6d4dcf00d0d6031d"
      },
      "/etc/ssl/certs/40193066.0": {
        "length": 2078,
        "offset": 85102232,
        "sha256": "9dd4cbb6d2c29cbb3ca98da02c042a690c0ef4c0521d98aae37e0a704c4bf210"
      },
      "/etc/ssl/certs/4042bcee.0": {
        "length": 1939,
        "offset": 85104310,
        "sha256": "22b557a27055b33606b6559f37703928d3e4ad79f110b407d04986e1843543d1"
      },
      "/etc/ssl/certs/40547a79.0": {
        "length": 1489,
        "offset": 85106249,
        "sha256": "e273097c7c57cb7cbb908057991ae1774d4e1e8c6a062fb6be9e6645b32fb431"
      },
      "/etc/ssl/certs/406c9bb1.0": {
        "length": 1257,
        "offset": 85107738,
        "sha256": "fb98230f8746d60429c20f8ce04254384337b479a77698939f7041d0c0eb4289"
      },
      "/etc/ssl/certs/48bec511.0": {
        "length": 1354,
        "offset": 85108995,
        "sha256": "43f1bade6454349c258017cc99113f8b6a5712e3807e82ad9371348d52d60190"
      },
      "/etc/ssl/certs/4b718d9b.0": {
        "length": 814,
        "offset": 85110349,
        "sha256": "b1d0ac5a261e857409cc921acb515796538b48847722f0a00ddccbf60bccec81"
      },
      "/etc/ssl/certs/4bfab552.0": {
        "length": 1399,
        "offset": 85111163,
        "sha256": "ca3760ba63bf0a2c5dd0dc7fe897838cc58f12a386b4ee53d2065229848e96a3"
      },
      "/etc/ssl/certs/4f316efb.0": {
        "length": 2045,
        "offset": 85112562,
        "sha256": "0ebb1a5d93b86ad9dcbd294413f272817fe3bb8ba46f4ec8192b3b805f2fa8ae"
      },
      "/etc/ssl/certs/5273a94c.0": {
        "length": 2244,
        "offset": 85114607,
        "sha256": "789655e3b4c0721faa6a3ffc30853450794fecc5830a12b632261545c3a241bb"
      },
      "/etc/ssl/certs/5443e9e3.0": {
        "length": 1367,
        "offset": 85116851,
        "sha256": "1cb130a113f4e8502517a679808a98bf076d59bdb223bfc61cd224b8e1abda49"
      },
      "/etc/ssl/certs/54657681.0": {
        "length": 1915,
        "offset": 85118218,
        "sha256": "9c2a7510e01aec2c9b8cc2c9d03b16576858a93863a6d0a31a2ac05f47f5dbe1"
      },
      "/etc/ssl/certs/57bcb2da.0": {
        "length": 2049,
        "offset": 85120133,
        "sha256": "9b3cbeb7d75271e0b62d40d60f8b18a35384ac6b171209231732fc778cfd2b5f"
      },
      "/etc/ssl/certs/5860aaa6.0": {
        "length": 830,
        "offset": 85122182,
        "sha256": "ef94d474067b306c482dfd066130f04855f50faecd461cee2964ce6c7260000e"
      },
      "/etc/ssl/certs/5931b5bc.0": {
        "length": 1050,
        "offset": 85123012,
        "sha256": "0b83e3ece7c33128cc31ac97595ce1bdb524db3f924623093b64e6a96ffb4b9b"
      },
      "/etc/ssl/certs/5a7722fb.0": {
        "length": 977,
        "offset": 85124062,
        "sha256": "7aa7e87cb29fb7303d8d2402c98b3855b45859640211773c279f0c046e2071c6"
      },
      "/etc/ssl/certs/5ad8a5d6.0": {
        "length": 1261,
        "offset": 85125039,
        "sha256": "df68841998b7fd098a9517fe971e97890be0fc93bbe1b2a1ef63ebdea3111c80"
      },
      "/etc/ssl/certs/5cd81ad7.0": {
        "length": 1870,
        "offset": 85126300,
        "sha256": "303c346ece82ca4f6713ac176164285d0469f326b6f12a787e11f5d702529277"
      },
      "/etc/ssl/certs/5d3033c5.0": {
        "length": 1513,
        "offset": 85128170,
        "sha256": "e227db3bb37e1158f9c5d9838d0ec74109d9816b60d69b3ca85def4b293d02dd"
      },
      "/etc/ssl/certs/5e98733a.0": {
        "length": 2244,
        "offset": 85129683,
        "sha256": "9e01d7bbaaf5ebd3e4ff9c02e3c3a12aaa421574ca86ddb0cb3a21880f2e283d"
      },
      "/etc/ssl/certs/5f15c80c.0": {
        "length": 1883,
        "offset": 85131927,
        "sha256": "5dadc31b57074a3168d1df23bb8b6b920acae1d426bf2288fc2de53cdd571089"
      },
      "/etc/ssl/certs/5f618aec.0": {
        "length": 1891,
        "offset": 85133810,
        "sha256": "80eee369aa5b29931209226fcb4b014ba31daa7f630d44a196817c1bb6b334f1"
      },
      "/etc/ssl/certs/607986c7.0": {
        "length": 1294,
        "offset": 85135701,
        "sha256": "5d550643b6400d4341550a9b14aedd0b4fac33ae5deb7d8247b6b4f799c13306"
      },
      "/etc/ssl/certs/626dceaf.0": {
        "length": 1911,
        "offset": 85136995,
        "sha256": "1a49076630e489e4b1056804fb6c768397a9de52b236609aaf6ec5b94ce508ec"
      },
      "/etc/ssl/certs/653b494a.0": {
        "length": 1261,
        "offset": 85138906,
        "sha256": "d1c290ea1e4544dec1934931fbfa1fb2060eb3a0f2239ba191f444ecbce35cbb"
      },
      "/etc/ssl/certs/66445960.0": {
        "length": 2122,
        "offset": 85140167,
        "sha256": "d96bfedd2e72169afa2cc958f122785a00e5cfc4b860eb8419c3196d99aced34"
      },
      "/etc/ssl/certs/68dd7389.0": {
        "length": 2074,
        "offset": 85142289,
        "sha256": "1fd9801787f30a4ab835b1462afc3f71473a5eacc74c0a22ed392bc3da9362f3"
      },
      "/etc/ssl/certs/6b99d060.0": {
        "length": 1643,
        "offset": 85144363,
        "sha256": "745bd29be45667514b4000e9cdb70cdecad0f02c78232ed722f64f7f80436e35"
      },
      "/etc/ssl/certs/6d41d539.0": {
        "length": 1883,
        "offset": 85146006,
        "sha256": "a3a7fe25439d9a9b50f60af43684444d798a4c869305bf615881e5c84a44c1a2"
      },
      "/etc/ssl/certs/6fa5da56.0": {
        "length": 2094,
        "offset": 85147889,
        "sha256": "2e368debd3626ea9c5d94c582d80050a530b505aa77ba231eb13e4d208c36d67"
      },
      "/etc/ssl/certs/706f604c.0": {
        "length": 1513,
        "offset": 85149983,
        "sha256": "fbe0f62dde93af96d1b8e27b19b2ee200a834880eca805585b66d18d2ea08192"
      },
      "/etc/ssl/certs/749e9e03.0": {
        "length": 1923,
        "offset": 85151496,
        "sha256": "4db45324410a01a7023b038e5da7d7274d3cfd392565c351cf3d297fd7664c73"
      },
      "/etc/ssl/certs/75d1b2ed.0": {
        "length": 1988,
        "offset": 85153419,
        "sha256": "ce7d6b44f5d510391be98c8d76b18709400a30cd87659bfebe1c6f97ff5181ee"
      },
      "/etc/ssl/certs/76faf6c0.0": {
        "length": 2354,
        "offset": 85155407,
        "sha256": "a2ae0b4ec9d2a4c4e150756a3defabd15bcaa75ee2b599e722b27c6a2998d00b"
      },
      "/etc/ssl/certs/7719f463.0": {
        "length": 1017,
        "offset": 85157761,
        "sha256": "1cdd90d42b48cced8f5ecbff087c49da56b224f0272e4b5074e63b82fff5fb16"
      },
      "/etc/ssl/certs/773e07ad.0": {
        "length": 895,
        "offset": 85158778,
        "sha256": "17b98c4d832e8349ecb55f1f90e41dfc7bcd9410d1e925ccd06612cd3b9b9a54"
      },
      "/etc/ssl/certs/7a3adc42.0": {
        "length": 1911,
        "offset": 85159673,
        "sha256": "8cc726cf62c554561e89e1237495bea3026b1709ba7153fed3401fcd489b5aaf"
      },
      "/etc/ssl/certs/7a780d93.0": {
        "length": 1891,
        "offset": 85161584,
        "sha256": "0c78902126532fde9eed4b2d8b6a2c9bbaa8b3abc59f233c45c6cb5514a9f808"
      },
      "/etc/ssl/certs/7aaf71c0.0": {
        "length": 1493,
        "offset": 85163475,
        "sha256": "0080981e6ff76e4f00a6fdf9e4e6cb98a9221eb334f4d43a07e194d23f648f47"
      },
      "/etc/ssl/certs/7f3d5d1d.0": {
        "length": 851,
        "offset": 85164968,
        "sha256": "c4fa4cc30be6aee0a4c0dff81f28768eedd83e8d4934a42f82179cbfa61f13ad"
      },
      "/etc/ssl/certs/8160b96c.0": {
        "length": 1460,
        "offset": 85165819,
        "sha256": "4f670affee7b14140a6d20937db6e991102d5f8bac1d2562ebf20a1afda94d73"
      },
      "/etc/ssl/certs/8508e720.0": {
        "length": 741,
        "offset": 85167279,
        "sha256": "1b28a5568648fef0d3faeb916cb7bdb054724cb3b5a00c6bfd3d8a2fba7a8bba"
      },
      "/etc/ssl/certs/8cb5ee0f.0": {
        "length": 656,
        "offset": 85168020,
        "sha256": "3eb7c3258f4af9222033dc1bb3dd2c7cfa0982b98e39fb8e9dc095cfeb38126c"
      },
      "/etc/ssl/certs/8d86cdd1.0": {
        "length": 1176,
        "offset": 85168676,
        "sha256": "cf339eae15268aff66148f3bcdf112a7700eafded3edcb3f86c60133b10e03f8"
      },
      "/etc/ssl/certs/8d89cda1.0": {
        "length": 875,
        "offset": 85169852,
        "sha256": "b4ee8ed700b7abe4836d119c8113bc8b717f4f1568abd7edd81f2526c5836983"
      },
      "/etc/ssl/certs/8f103249.0": {
        "length": 1952,
        "offset": 85170727,
        "sha256": "bf3bd189c3dd33bc81635d60284461f0d937c2c1d51cc4d7851c13466419fcb0"
      },
      "/etc/ssl/certs/90c5a3c8.0": {
        "length": 1939,
        "offset": 85172679,
        "sha256": "c3f06f635f1939ebeb125e5c1f030e329b63dd808d3ce803b1b1794bc78b253a"
      },
      "/etc/ssl/certs/930ac5d2.0": {
        "length": 2049,
        "offset": 85174618,
        "sha256": "c6d25347727f267774611677588d76f8a54a6e14d3e99dd69ef2c20612ed87c5"
      },
      "/etc/ssl/certs/93bc0acc.0": {
        "length": 1204,
        "offset": 85176667,
        "sha256": "b68109f50ba0abed3b938afebd2ab42a2f5089062c59e9fc74425e2742d894bc"
      },
      "/etc/ssl/certs/9482e63a.0": {
        "length": 891,
        "offset": 85177871,
        "sha256": "c4a426fe57a7e4e6966e2103f2941eb7263e7c35727dd0f412bd593467304999"
      },
      "/etc/ssl/certs/9846683b.0": {
        "length": 790,
        "offset": 85178762,
        "sha256": "05161ad2ac04a0df956ef803e127aa877cc5131e0a727ed8e5de43f02e8868c4"
      },
      "/etc/ssl/certs/988a38cb.0": {
        "length": 1476,
        "offset": 85179552,
        "sha256": "40f60f2e2f83fb6c63ddefeba7939a7852b2d468183ea939cc4dcac8fe4cc87d"
      },
      "/etc/ssl/certs/9b5697b0.0": {
        "length": 883,
        "offset": 85181028,
        "sha256": "f08c4d2b700f7cd5da4dc1b60f4c57090fdc692cde8a7221f35b70abb4cec363"
      },
      "/etc/ssl/certs/9c8dfbd4.0": {
        "length": 753,
        "offset": 85181911,
        "sha256": "42f0e946149ae0e0c6a1fb0e33150ce863479b2ef7b3c700161102ad1dcb34c1"
      },
      "/etc/ssl/certs/9d04f354.0": {
        "length": 1306,
        "offset": 85182664,
        "sha256": "660b5aa96668c5162f4af6b0a01241d8527aef8fa8a5307a7033b83c3de4a72d"
      },
      "/etc/ssl/certs/9ef4a08a.0": {
        "length": 1050,
        "offset": 85183970,
        "sha256": "ae927c01e73470cfc89943b5cd8f26e481d55c833517c1017f3fef404a38a317"
      },
      "/etc/ssl/certs/9f727ac7.0": {
        "length": 2017,
        "offset": 85185020,
        "sha256": "05e0ebf9643197ccf8036cdd86a2ee14292c2a077dbe06435ed30369b8762564"
      },
      "/etc/ssl/certs/ACCVRAIZ1.pem": {
        "length": 2772,
        "offset": 85187037,
        "sha256": "04846f73d9d0421c60076fd02bad7f0a81a3f11a028d653b0de53290e41dcead"
      },
      "/etc/ssl/certs/AC_RAIZ_FNMT-RCM.pem": {
        "length": 1972,
        "offset": 85189809,
        "sha256": "aa18ea4c9a8441a461bb436a1c90beb994ac841980b8fd62c72de9a62ddf8ae3"
      },
      "/etc/ssl/certs/AC_RAIZ_FNMT-RCM_SERVIDORES_SEGUROS.pem": {
        "length": 904,
        "offset": 85191781,
        "sha256": "8e3f237813d3f3e2f5767bc2a694a7557f84bb79fd60ef1adc25afd0c1fc5ef6"
      },
      "/etc/ssl/certs/ANF_Secure_Server_Root_CA.pem": {
        "length": 2118,
        "offset": 85192685,
        "sha256": "efb2df6e0075fa74e448077e402d171851b2ffe4668a614adc00dcbc75633afd"
      },
      "/etc/ssl/certs/Actalis_Authentication_Root_CA.pem": {
        "length": 2049,
        "offset": 85194803,
        "sha256": "c6d25347727f267774611677588d76f8a54a6e14d3e99dd69ef2c20612ed87c5"
      },
      "/etc/ssl/certs/AffirmTrust_Commercial.pem": {
        "length": 1204,
        "offset": 85196852,
        "sha256": "7108110fdaf19e3e5a7ed8fa38557248e79fe78bb2e9eefe7a0bb801cbfd2db7"
      },
      "/etc/ssl/certs/AffirmTrust_Networking.pem": {
        "length": 1204,
        "offset": 85198056,
        "sha256": "b68109f50ba0abed3b938afebd2ab42a2f5089062c59e9fc74425e2742d894bc"
      },
      "/etc/ssl/certs/AffirmTrust_Premium.pem": {
        "length": 1891,
        "offset": 85199260,
        "sha256": "94c88202bf2c13c68b90d124f93f62374f36776b0bfbc110c6d06f829290b580"
      },
      "/etc/ssl/certs/AffirmTrust_Premium_ECC.pem": {
        "length": 753,
        "offset": 85201151,
        "sha256": "42f0e946149ae0e0c6a1fb0e33150ce863479b2ef7b3c700161102ad1dcb34c1"
      },
      "/etc/ssl/certs/Amazon_Root_CA_1.pem": {
        "length": 1188,
        "offset": 85201904,
        "sha256": "2c43952ee9e000ff2acc4e2ed0897c0a72ad5fa72c3d934e81741cbd54f05bd1"
      },
      "/etc/ssl/certs/Amazon_Root_CA_2.pem": {
        "length": 1883,
        "offset": 85203092,
        "sha256": "a3a7fe25439d9a9b50f60af43684444d798a4c869305bf615881e5c84a44c1a2"
      },
      "/etc/ssl/certs/Amazon_Root_CA_3.pem": {
        "length": 656,
        "offset": 85204975,
        "sha256": "3eb7c3258f4af9222033dc1bb3dd2c7cfa0982b98e39fb8e9dc095cfeb38126c"
      },
      "/etc/ssl/certs/Amazon_Root_CA_4.pem": {
        "length": 737,
        "offset": 85205631,
        "sha256": "b0b7961120481e33670315b2f843e643c42f693c7a1010eb9555e06ddc730214"
      },
      "/etc/ssl/certs/Atos_TrustedRoot_2011.pem": {
        "length": 1261,
        "offset": 85206368,
        "sha256": "79e9f88ab505186e36f440c88bc37e103e1a9369a0ebe382c4a04bd70b91c027"
      },
      "/etc/ssl/certs/Autoridad_de_Certificacion_Firmaprofesional_CIF_A62634068.pem": {
        "length": 2167,
        "offset": 85207629,
        "sha256": "283fd555713ed4ecfcb4935f5ed5d4a9bb776236803e2910eb46e70903a3511f"
      },
      "/etc/ssl/certs/Autoridad_de_Certificacion_Firmaprofesional_CIF_A62634068_2.pem": {
        "length": 2167,
        "offset": 85209796,
        "sha256": "a618213c5dd7cbb59b3154de7241d7255333a0619cf434329becae876ce6e331"
      },
      "/etc/ssl/certs/Baltimore_CyberTrust_Root.pem": {
        "length": 1261,
        "offset": 85211963,
        "sha256": "d1c290ea1e4544dec1934931fbfa1fb2060eb3a0f2239ba191f444ecbce35cbb"
      },
      "/etc/ssl/certs/Buypass_Class_2_Root_CA.pem": {
        "length": 1915,
        "offset": 85213224,
        "sha256": "9c2a7510e01aec2c9b8cc2c9d03b16576858a93863a6d0a31a2ac05f47f5dbe1"
      },
      "/etc/ssl/certs/Buypass_Class_3_Root_CA.pem": {
        "length": 1915,
        "offset": 85215139,
        "sha256": "8db5b7c8f058c56a8d033c2443d34fdfd3656150eaa73fe63c65161e7063ce99"
      },
      "/etc/ssl/certs/CA_Disig_Root_R2.pem": {
        "length": 1935,
        "offset": 85217054,
        "sha256": "8adefca890c92e6d0877fdcba07655296852217da657026aea69ee547642528c"
      },
      "/etc/ssl/certs/CFCA_EV_ROOT.pem": {
        "length": 1984,
        "offset": 85218989,
        "sha256": "94e4ab21333740d7ed0f2b5007744e5cf6792c0ddf4c6bdfb3ce8333010e7306"
      },
      "/etc/ssl/certs/COMODO_Certification_Authority.pem": {
        "length": 1489,
        "offset": 85220973,
        "sha256": "e273097c7c57cb7cbb908057991ae1774d4e1e8c6a062fb6be9e6645b32fb431"
      },
      "/etc/ssl/certs/COMODO_ECC_Certification_Authority.pem": {
        "length": 940,
        "offset": 85222462,
        "sha256": "d69f7b57250536f57ffba92cffe82a8bbcb16e03a9a2607ec967f362ce83f9ce"
      },
      "/etc/ssl/certs/COMODO_RSA_Certification_Authority.pem": {
        "length": 2086,
        "offset": 85223402,
        "sha256": "24b0d4292dacb02efc38542838e378bc35f040dcd21bebfddbc82dc7feb2876d"
      },
      "/etc/ssl/certs/Certainly_Root_E1.pem": {
        "length": 741,
        "offset": 85225488,
        "sha256": "1b28a5568648fef0d3faeb916cb7bdb054724cb3b5a00c6bfd3d8a2fba7a8bba"
      },
      "/etc/ssl/certs/Certainly_Root_R1.pem": {
        "length": 1891,
        "offset": 85226229,
        "sha256": "0c78902126532fde9eed4b2d8b6a2c9bbaa8b3abc59f233c45c6cb5514a9f808"
      },
      "/etc/ssl/certs/Certigna.pem": {
        "length": 1330,
        "offset": 85228120,
        "sha256": "d1e1969cdbc656bb4c568116fe2d9b4f8b02b170dc20193b86a26c046f4b35a7"
      },
      "/etc/ssl/certs/Certigna_Root_CA.pem": {
        "length": 2264,
        "offset": 85229450,
        "sha256": "fe3b44c18182e167121a2c645cecc4817441d469dc00633e60fe8476f9e1ad96"
      },
      "/etc/ssl/certs/Certum_EC-384_CA.pem": {
        "length": 891,
        "offset": 85231714,
        "sha256": "c4a426fe57a7e4e6966e2103f2941eb7263e7c35727dd0f412bd593467304999"
      },
      "/etc/ssl/certs/Certum_Trusted_Network_CA.pem": {
        "length": 1354,
        "offset": 85232605,
        "sha256": "43f1bade6454349c258017cc99113f8b6a5712e3807e82ad9371348d52d60190"
      },
      "/etc/ssl/certs/Certum_Trusted_Network_CA_2.pem": {
        "length": 2078,
        "offset": 85233959,
        "sha256": "9dd4cbb6d2c29cbb3ca98da02c042a690c0ef4c0521d98aae37e0a704c4bf210"
      },
      "/etc/ssl/certs/Certum_Trusted_Root_CA.pem": {
        "length": 2053,
        "offset": 85236037,
        "sha256": "e6c62d3f63ba03f4dac458b7dac6c09eb4d71cc3c6621769c3883ed51677c01c"
      },
      "/etc/ssl/certs/Comodo_AAA_Services_root.pem": {
        "length": 1517,
        "offset": 85238090,
        "sha256": "a5ddabd1602ae1c66ce11ad078e734cc473dcb8e9f573037832d8536ae3de90b"
      },
      "/etc/ssl/certs/D-TRUST_BR_Root_CA_1_2020.pem": {
        "length": 1050,
        "offset": 85239607,
        "sha256": "ae927c01e73470cfc89943b5cd8f26e481d55c833517c1017f3fef404a38a317"
      },
      "/etc/ssl/certs/D-TRUST_EV_Root_CA_1_2020.pem": {
        "length": 1050,
        "offset": 85240657,
        "sha256": "0b83e3ece7c33128cc31ac97595ce1bdb524db3f924623093b64e6a96ffb4b9b"
      },
      "/etc/ssl/certs/D-TRUST_Root_Class_3_CA_2_2009.pem": {
        "length": 1517,
        "offset": 85241707,
        "sha256": "a00b8aa918457f5e7e58457b5e2f80d640fa77cc290572aaab1ae7b4734a9528"
      },
      "/etc/ssl/certs/D-TRUST_Root_Class_3_CA_2_EV_2009.pem": {
        "length": 1537,
        "offset": 85243224,
        "sha256": "f81ceeaf6341513ef391ab3ea3302e8b2fb2c1527752797bba9b20ca22048b3c"
      },
      "/etc/ssl/certs/DigiCert_Assured_ID_Root_CA.pem": {
        "length": 1350,
        "offset": 85244761,
        "sha256": "b52fae9cd8dcf49285f0337cd815deca13fedd31f653bf07f61579451517e18c"
      },
      "/etc/ssl/certs/DigiCert_Assured_ID_Root_G2.pem": {
        "length": 1306,
        "offset": 85246111,
        "sha256": "660b5aa96668c5162f4af6b0a01241d8527aef8fa8a5307a7033b83c3de4a72d"
      },
      "/etc/ssl/certs/DigiCert_Assured_ID_Root_G3.pem": {
        "length": 851,
        "offset": 85247417,
        "sha256": "c4fa4cc30be6aee0a4c0dff81f28768eedd83e8d4934a42f82179cbfa61f13ad"
      },
      "/etc/ssl/certs/DigiCert_Global_Root_CA.pem": {
        "length": 1338,
        "offset": 85248268,
        "sha256": "39fdcf28aeffe08d03251fccaf645e3c5de19fa4ebbafc89b4ede2a422148bab"
      },
      "/etc/ssl/certs/DigiCert_Global_Root_G2.pem": {
        "length": 1294,
        "offset": 85249606,
        "sha256": "5d550643b6400d4341550a9b14aedd0b4fac33ae5deb7d8247b6b4f799c13306"
      },
      "/etc/ssl/certs/DigiCert_Global_Root_G3.pem": {
        "length": 839,
        "offset": 85250900,
        "sha256": "1914cd2d4cde263315f9e32c7683fc0e1b921919ad12b256d49bf782011c03cc"
      },
      "/etc/ssl/certs/DigiCert_High_Assurance_EV_Root_CA.pem": {
        "length": 1367,
        "offset": 85251739,
        "sha256": "d98f681c3a7dce812b90bf7c68046827f3bf5607357f1e4918c5dc813b359bf1"
      },
      "/etc/ssl/certs/DigiCert_TLS_ECC_P384_Root_G5.pem": {
        "length": 790,
        "offset": 85253106,
        "sha256": "05161ad2ac04a0df956ef803e127aa877cc5131e0a727ed8e5de43f02e8868c4"
      },
      "/etc/ssl/certs/DigiCert_TLS_RSA4096_Root_G5.pem": {
        "length": 1931,
        "offset": 85253896,
        "sha256": "fe64d4b3ae749db5ec57b04ed9203c748fff446f57b9665fad988435d89c9e43"
      },
      "/etc/ssl/certs/DigiCert_Trusted_Root_G4.pem": {
        "length": 1988,
        "offset": 85255827,
        "sha256": "ce7d6b44f5d510391be98c8d76b18709400a30cd87659bfebe1c6f97ff5181ee"
      },
      "/etc/ssl/certs/E-Tugra_Certification_Authority.pem": {
        "length": 2244,
        "offset": 85257815,
        "sha256": "789655e3b4c0721faa6a3ffc30853450794fecc5830a12b632261545c3a241bb"
      },
      "/etc/ssl/certs/E-Tugra_Global_Root_CA_ECC_v3.pem": {
        "length": 977,
        "offset": 85260059,
        "sha256": "7aa7e87cb29fb7303d8d2402c98b3855b45859640211773c279f0c046e2071c6"
      },
      "/etc/ssl/certs/E-Tugra_Global_Root_CA_RSA_v3.pem": {
        "length": 2122,
        "offset": 85261036,
        "sha256": "d96bfedd2e72169afa2cc958f122785a00e5cfc4b860eb8419c3196d99aced34"
      },
      "/etc/ssl/certs/Entrust.net_Premium_2048_Secure_Server_CA.pem": {
        "length": 1505,
        "offset": 85263158,
        "sha256": "24e0277c0c028497c6b0abbbf7163ec3ae7b341cadfb0b90bc00c4ad642172cc"
      },
      "/etc/ssl/certs/Entrust_Root_Certification_Authority.pem": {
        "length": 1643,
        "offset": 85264663,
        "sha256": "745bd29be45667514b4000e9cdb70cdecad0f02c78232ed722f64f7f80436e35"
      },
      "/etc/ssl/certs/Entrust_Root_Certification_Authority_-_EC1.pem": {
        "length": 1090,
        "offset": 85266306,
        "sha256": "a0d7e56b32b767e076bd7d05ce1779dbe3656d0a02a9abe711fc79640b9f7fbe"
      },
      "/etc/ssl/certs/Entrust_Root_Certification_Authority_-_G2.pem": {
        "length": 1533,
        "offset": 85267396,
        "sha256": "646db48fa7794bcab4581f264ff3fad4cff7bbd24f5e8bb170d4f602b6caf828"
      },
      "/etc/ssl/certs/Entrust_Root_Certification_Authority_-_G4.pem": {
        "length": 2244,
        "offset": 85268929,
        "sha256": "9e01d7bbaaf5ebd3e4ff9c02e3c3a12aaa421574ca86ddb0cb3a21880f2e283d"
      },
      "/etc/ssl/certs/GDCA_TrustAUTH_R5_ROOT.pem": {
        "length": 1980,
        "offset": 85271173,
        "sha256": "b0bf3a444f89d8be7db120bfecaa2f94d9e49ede21f680d674c1e8d839d8a9a2"
      },
      "/etc/ssl/certs/GLOBALTRUST_2020.pem": {
        "length": 1972,
        "offset": 85273153,
        "sha256": "b3bcd05e1b177130f6888fcc1cff4e01cff44ef8e6b0d035f04ad6a71dd0879c"
      },
      "/etc/ssl/certs/GTS_Root_R1.pem": {
        "length": 1911,
        "offset": 85275125,
        "sha256": "4195ea007a7ef8d3e2d338e8d9ff0083198e36bfa025442ddf41bb5213904fc2"
      },
      "/etc/ssl/certs/GTS_Root_R2.pem": {
        "length": 1911,
        "offset": 85277036,
        "sha256": "1a49076630e489e4b1056804fb6c768397a9de52b236609aaf6ec5b94ce508ec"
      },
      "/etc/ssl/certs/GTS_Root_R3.pem": {
        "length": 765,
        "offset": 85278947,
        "sha256": "39238e09bb7d30e39fbf87746ceac206f7ec206cff3d73c743e3f818ca2ec54f"
      },
      "/etc/ssl/certs/GTS_Root_R4.pem": {
        "length": 765,
        "offset": 85279712,
        "sha256": "7e8b80d078d3dd77d3ed2108dd2b33412c12d7d72cb0965741c70708691776a2"
      },
      "/etc/ssl/certs/GlobalSign_ECC_Root_CA_-_R4.pem": {
        "length": 704,
        "offset": 85280477,
        "sha256": "d1b69887f73444c0fc0a6f22a2fe961c2423275f9c38ba7d50da2a4ba75394f1"
      },
      "/etc/ssl/certs/GlobalSign_ECC_Root_CA_-_R5.pem": {
        "length": 794,
        "offset": 85281181,
        "sha256": "80eeafa5039f282345129a81ace7e1c1e1d4fd826f1eb3391a4ea56f38a6e3d8"
      },
      "/etc/ssl/certs/GlobalSign_Root_CA.pem": {
        "length": 1261,
        "offset": 85281975,
        "sha256": "df68841998b7fd098a9517fe971e97890be0fc93bbe1b2a1ef63ebdea3111c80"
      },
      "/etc/ssl/certs/GlobalSign_Root_CA_-_R3.pem": {
        "length": 1229,
        "offset": 85283236,
        "sha256": "6bdc59f897631af7811e3201cbc58e5999de2600ae8667454a34514eecfd8381"
      },
      "/etc/ssl/certs/GlobalSign_Root_CA_-_R6.pem": {
        "length": 1972,
        "offset": 85284465,
        "sha256": "5ff8425be71c1805446bf10601ce3cb9619889866766fc9285583ca5a4a7de94"
      },
      "/etc/ssl/certs/GlobalSign_Root_E46.pem": {
        "length": 769,
        "offset": 85286437,
        "sha256": "5bd16128d0934629c2e1713140a6f97c9828dbb5429ab5797b2573efc71de1a1"
      },
      "/etc/ssl/certs/GlobalSign_Root_R46.pem": {
        "length": 1915,
        "offset": 85287206,
        "sha256": "dcc1a6246e13880ca5b73ef547e082dd0401e4d8837b6d211be82f7be791ac65"
      },
      "/etc/ssl/certs/Go_Daddy_Class_2_CA.pem": {
        "length": 1448,
        "offset": 85289121,
        "sha256": "47f15a52a984ab1f9cd92b6c1849c0465c1b3c9c6837d54e5d2c004fa01b69b7"
      },
      "/etc/ssl/certs/Go_Daddy_Root_Certificate_Authority_-_G2.pem": {
        "length": 1367,
        "offset": 85290569,
        "sha256": "500329abac100a953a7396b54b36be57d333022f17401bc948248ea179cf1784"
      },
      "/etc/ssl/certs/HARICA_TLS_ECC_Root_CA_2021.pem": {
        "length": 867,
        "offset": 85291936,
        "sha256": "c6dc63e98b3a5e6a595c7d583a9c47c5efb6d316957466fd16c785b423eacf37"
      },
      "/etc/ssl/certs/HARICA_TLS_RSA_Root_CA_2021.pem": {
        "length": 2017,
        "offset": 85292803,
        "sha256": "05e0ebf9643197ccf8036cdd86a2ee14292c2a077dbe06435ed30369b8762564"
      },
      "/etc/ssl/certs/Hellenic_Academic_and_Research_Institutions_ECC_RootCA_2015.pem": {
        "length": 1017,
        "offset": 85294820,
        "sha256": "1cdd90d42b48cced8f5ecbff087c49da56b224f0272e4b5074e63b82fff5fb16"
      },
      "/etc/ssl/certs/Hellenic_Academic_and_Research_Institutions_RootCA_2015.pem": {
        "length": 2155,
        "offset": 85295837,
        "sha256": "677160e6297b48b87ede98ab7b4f2be55894491776f6191937ea397d01a6fb4b"
      },
      "/etc/ssl/certs/HiPKI_Root_CA_-_G1.pem": {
        "length": 1939,
        "offset": 85297992,
        "sha256": "c3f06f635f1939ebeb125e5c1f030e329b63dd808d3ce803b1b1794bc78b253a"
      },
      "/etc/ssl/certs/Hongkong_Post_Root_CA_1.pem": {
        "length": 1168,
        "offset": 85299931,
        "sha256": "9dd93324ad79de9a6d595611342d38ae6ca937772c65e11da3ebf88c5a248115"
      },
      "/etc/ssl/certs/Hongkong_Post_Root_CA_3.pem": {
        "length": 2074,
        "offset": 85301099,
        "sha256": "1fd9801787f30a4ab835b1462afc3f71473a5eacc74c0a22ed392bc3da9362f3"
      },
      "/etc/ssl/certs/ISRG_Root_X1.pem": {
        "length": 1939,
        "offset": 85303173,
        "sha256": "22b557a27055b33606b6559f37703928d3e4ad79f110b407d04986e1843543d1"
      },
      "/etc/ssl/certs/ISRG_Root_X2.pem": {
        "length": 790,
        "offset": 85305112,
        "sha256": "a13d881e11fe6df181b53841f9fa738a2d7ca9ae7be3d53c866f722b4242b013"
      },
      "/etc/ssl/certs/IdenTrust_Commercial_Root_CA_1.pem": {
        "length": 1923,
        "offset": 85305902,
        "sha256": "1d03b965511ce50d0a0bae1b549ed7048c783cfcba9aa40ea11d355b1889657c"
      },
      "/etc/ssl/certs/IdenTrust_Public_Sector_Root_CA_1.pem": {
        "length": 1931,
        "offset": 85307825,
        "sha256": "9b4282f5a402e19016c4874a52df3367eabccf05be851ad03039f777a602d30a"
      },
      "/etc/ssl/certs/Izenpe.com.pem": {
        "length": 2122,
        "offset": 85309756,
        "sha256": "1d37341b099afc610bf4feb387096577a0dc61bb8fd09444f1a199a1b1b117e3"
      },
      "/etc/ssl/certs/Microsec_e-Szigno_Root_CA_2009.pem": {
        "length": 1460,
        "offset": 85311878,
        "sha256": "4f670affee7b14140a6d20937db6e991102d5f8bac1d2562ebf20a1afda94d73"
      },
      "/etc/ssl/certs/Microsoft_ECC_Root_Certificate_Authority_2017.pem": {
        "length": 875,
        "offset": 85313338,
        "sha256": "b4ee8ed700b7abe4836d119c8113bc8b717f4f1568abd7edd81f2526c5836983"
      },
      "/etc/ssl/certs/Microsoft_RSA_Root_Certificate_Authority_2017.pem": {
        "length": 2021,
        "offset": 85314213,
        "sha256": "626d330f6a8944fa4245f02f9795668e25a40b29b4cc5206bee73337b7dcd4d5"
      },
      "/etc/ssl/certs/NAVER_Global_Root_Certification_Authority.pem": {
        "length": 2013,
        "offset": 85316234,
        "sha256": "9848c94859f83e48defe0b25a0f4347480b56ea2bb3336fe6d4dcf00d0d6031d"
      },
      "/etc/ssl/certs/NetLock_Arany_=Class_Gold=_F\u0151tan\u00fas\u00edtv\u00e1ny.pem": {
        "length": 1476,
        "offset": 85318247,
        "sha256": "40f60f2e2f83fb6c63ddefeba7939a7852b2d468183ea939cc4dcac8fe4cc87d"
      },
      "/etc/ssl/certs/OISTE_WISeKey_Global_Root_GB_CA.pem": {
        "length": 1346,
        "offset": 85319723,
        "sha256": "2dc52d373089ff5173ac392a464746dd066aaa3b7d1b3494a473c96686666fce"
      },
      "/etc/ssl/certs/OISTE_WISeKey_Global_Root_GC_CA.pem": {
        "length": 895,
        "offset": 85321069,
        "sha256": "17b98c4d832e8349ecb55f1f90e41dfc7bcd9410d1e925ccd06612cd3b9b9a54"
      },
      "/etc/ssl/certs/QuoVadis_Root_CA_1_G3.pem": {
        "length": 1923,
        "offset": 85321964,
        "sha256": "4db45324410a01a7023b038e5da7d7274d3cfd392565c351cf3d297fd7664c73"
      },
      "/etc/ssl/certs/QuoVadis_Root_CA_2.pem": {
        "length": 2041,
        "offset": 85323887,
        "sha256": "8c4220477ed85355fa380466aa8f559106d8a39fc90d3e0c121749e19444064f"
      },
      "/etc/ssl/certs/QuoVadis_Root_CA_2_G3.pem": {
        "length": 1923,
        "offset": 85325928,
        "sha256": "825c67f5583131425c4e33275cc8e5c9dfd02cd190c6d71e1d335621e82965a8"
      },
      "/etc/ssl/certs/QuoVadis_Root_CA_3.pem": {
        "length": 2354,
        "offset": 85327851,
        "sha256": "a2ae0b4ec9d2a4c4e150756a3defabd15bcaa75ee2b599e722b27c6a2998d00b"
      },
      "/etc/ssl/certs/QuoVadis_Root_CA_3_G3.pem": {
        "length": 1923,
        "offset": 85330205,
        "sha256": "198cfe560c191a800cbe923ceca0a4e4f3d5a0d7ff9316b47998765fdc0897be"
      },
      "/etc/ssl/certs/SSL.com_EV_Root_Certification_Authority_ECC.pem": {
        "length": 956,
        "offset": 85332128,
        "sha256": "662d60a283f416d888ff18831009e2cba95c61377f648beeed91a3dea12ac286"
      },
      "/etc/ssl/certs/SSL.com_EV_Root_Certification_Authority_RSA_R2.pem": {
        "length": 2114,
        "offset": 85333084,
        "sha256": "a0681f1a11d5c02760bcb68b61b0d332f6c197e239c4b30dc47f91a79a73282b"
      },
      "/etc/ssl/certs/SSL.com_Root_Certification_Authority_ECC.pem": {
        "length": 944,
        "offset": 85335198,
        "sha256": "b68d02ce35bd02123cf5fcd329bdd33640214715dae0442a97782a4471e9b292"
      },
      "/etc/ssl/certs/SSL.com_Root_Certification_Authority_RSA.pem": {
        "length": 2094,
        "offset": 85336142,
        "sha256": "2e368debd3626ea9c5d94c582d80050a530b505aa77ba231eb13e4d208c36d67"
      },
      "/etc/ssl/certs/SZAFIR_ROOT_CA2.pem": {
        "length": 1257,
        "offset": 85338236,
        "sha256": "cbe8a1eec737c93d1c1cc54e31421f81bf358aa43fbc1ac763d80ce61a17fce0"
      },
      "/etc/ssl/certs/SecureSign_RootCA11.pem": {
        "length": 1249,
        "offset": 85339493,
        "sha256": "20828fd7b9795221c10272f9f6ed29638f6dc2614465adab1b93f2bfc484c659"
      },
      "/etc/ssl/certs/SecureTrust_CA.pem": {
        "length": 1350,
        "offset": 85340742,
        "sha256": "a3e70af2c4b48562b61fe858d9d30f073f2cf2136f2af01ab5a966673e70af4b"
      },
      "/etc/ssl/certs/Secure_Global_CA.pem": {
        "length": 1354,
        "offset": 85342092,
        "sha256": "7ee52fb3a5afacd55a7a2e00f057f7f64776ea0d536036f54c57694961e25179"
      },
      "/etc/ssl/certs/Security_Communication_ECC_RootCA1.pem": {
        "length": 830,
        "offset": 85343446,
        "sha256": "ef94d474067b306c482dfd066130f04855f50faecd461cee2964ce6c7260000e"
      },
      "/etc/ssl/certs/Security_Communication_RootCA2.pem": {
        "length": 1261,
        "offset": 85344276,
        "sha256": "39ad3110b8f84821ca22cfbd995914f2149521d27ce576e743de6a00dc39d9db"
      },
      "/etc/ssl/certs/Security_Communication_RootCA3.pem": {
        "length": 1968,
        "offset": 85345537,
        "sha256": "40ec121c66bc70c48d5e512fa2d1d9f040c329467232f1964edd62fecb32af87"
      },
      "/etc/ssl/certs/Security_Communication_Root_CA.pem": {
        "length": 1224,
        "offset": 85347505,
        "sha256": "684f2f6ce0a18fcb038d08a495846fbc35b96d99875fef1b24384cf0944a68c3"
      },
      "/etc/ssl/certs/Starfield_Class_2_CA.pem": {
        "length": 1468,
        "offset": 85348729,
        "sha256": "1ad8373ec50073168cb6862a0e119adf2c1065c896adf7eb9695779739b4bb2e"
      },
      "/etc/ssl/certs/Starfield_Root_Certificate_Authority_-_G2.pem": {
        "length": 1399,
        "offset": 85350197,
        "sha256": "ca3760ba63bf0a2c5dd0dc7fe897838cc58f12a386b4ee53d2065229848e96a3"
      },
      "/etc/ssl/certs/Starfield_Services_Root_Certificate_Authority_-_G2.pem": {
        "length": 1424,
        "offset": 85351596,
        "sha256": "870f56d009d8aeb95b716b0e7b0020225d542c4b283b9ed896edf97428d6712e"
      },
      "/etc/ssl/certs/SwissSign_Gold_CA_-_G2.pem": {
        "length": 2045,
        "offset": 85353020,
        "sha256": "0ebb1a5d93b86ad9dcbd294413f272817fe3bb8ba46f4ec8192b3b805f2fa8ae"
      },
      "/etc/ssl/certs/SwissSign_Silver_CA_-_G2.pem": {
        "length": 2049,
        "offset": 85355065,
        "sha256": "9b3cbeb7d75271e0b62d40d60f8b18a35384ac6b171209231732fc778cfd2b5f"
      },
      "/etc/ssl/certs/T-TeleSec_GlobalRoot_Class_2.pem": {
        "length": 1367,
        "offset": 85357114,
        "sha256": "b30989fd9e45c74bf417df74d1da639d1f04d4fd0900be813a2d6a031a56c845"
      },
      "/etc/ssl/certs/T-TeleSec_GlobalRoot_Class_3.pem": {
        "length": 1367,
        "offset": 85358481,
        "sha256": "1cb130a113f4e8502517a679808a98bf076d59bdb223bfc61cd224b8e1abda49"
      },
      "/etc/ssl/certs/TUBITAK_Kamu_SM_SSL_Kok_Sertifikasi_-_Surum_1.pem": {
        "length": 1582,
        "offset": 85359848,
        "sha256": "c6904218e180fbfb0ed91d81e892c2dd983c4a3404617cb36aeb3a434c3b9df0"
      },
      "/etc/ssl/certs/TWCA_Global_Root_CA.pem": {
        "length": 1883,
        "offset": 85361430,
        "sha256": "5dadc31b57074a3168d1df23bb8b6b920acae1d426bf2288fc2de53cdd571089"
      },
      "/etc/ssl/certs/TWCA_Root_Certification_Authority.pem": {
        "length": 1269,
        "offset": 85363313,
        "sha256": "b69a59344e58615a691fa9567d55ad6337f09b57647a389242cbf43716575559"
      },
      "/etc/ssl/certs/TeliaSonera_Root_CA_v1.pem": {
        "length": 1870,
        "offset": 85364582,
        "sha256": "303c346ece82ca4f6713ac176164285d0469f326b6f12a787e11f5d702529277"
      },
      "/etc/ssl/certs/Telia_Root_CA_v2.pem": {
        "length": 1952,
        "offset": 85366452,
        "sha256": "bf3bd189c3dd33bc81635d60284461f0d937c2c1d51cc4d7851c13466419fcb0"
      },
      "/etc/ssl/certs/TrustCor_ECA-1.pem": {
        "length": 1493,
        "offset": 85368404,
        "sha256": "0080981e6ff76e4f00a6fdf9e4e6cb98a9221eb334f4d43a07e194d23f648f47"
      },
      "/etc/ssl/certs/TrustCor_RootCert_CA-1.pem": {
        "length": 1513,
        "offset": 85369897,
        "sha256": "e227db3bb37e1158f9c5d9838d0ec74109d9816b60d69b3ca85def4b293d02dd"
      },
      "/etc/ssl/certs/TrustCor_RootCert_CA-2.pem": {
        "length": 2204,
        "offset": 85371410,
        "sha256": "b4dc2f45b7ba821ff240be0d0c816a996cafae929b8f445b0510d9073e1aad5e"
      },
      "/etc/ssl/certs/Trustwave_Global_Certification_Authority.pem": {
        "length": 2090,
        "offset": 85373614,
        "sha256": "0c7ffc481084cad9ccd3402eba9401b0f5abea0917d985e9ce401c8efbad4b04"
      },
      "/etc/ssl/certs/Trustwave_Global_ECC_P256_Certification_Authority.pem": {
        "length": 883,
        "offset": 85375704,
        "sha256": "f08c4d2b700f7cd5da4dc1b60f4c57090fdc692cde8a7221f35b70abb4cec363"
      },
      "/etc/ssl/certs/Trustwave_Global_ECC_P384_Certification_Authority.pem": {
        "length": 969,
        "offset": 85376587,
        "sha256": "a83c5b6097b03509711c9cd8de59def7ecf99ed72b4076dc33f5b2e35545b3b3"
      },
      "/etc/ssl/certs/TunTrust_Root_CA.pem": {
        "length": 2037,
        "offset": 85377556,
        "sha256": "8a852f7182753cb0193299c6cb2b4a106b1c38a789217b5eb380d736c5cc0081"
      },
      "/etc/ssl/certs/UCA_Extended_Validation_Root.pem": {
        "length": 1915,
        "offset": 85379593,
        "sha256": "eaa3be600a842e5b603316ed14e9ae11a43003f68a8317f0f2c01a516da4e586"
      },
      "/etc/ssl/certs/UCA_Global_G2_Root.pem": {
        "length": 1891,
        "offset": 85381508,
        "sha256": "de2e7b1bc7a2aed4e5866d3655d1041206c27caf376ee81bfc4012e8225e0e7c"
      },
      "/etc/ssl/certs/USERTrust_ECC_Certification_Authority.pem": {
        "length": 948,
        "offset": 85383399,
        "sha256": "08fb40ba4144166f6ae80c7ab60be23e97e5083836d45fa85a33a5d0bfec10f8"
      },
      "/etc/ssl/certs/USERTrust_RSA_Certification_Authority.pem": {
        "length": 2094,
        "offset": 85384347,
        "sha256": "8a3dbcb92ab1c6277647fe2ab8536b5c982abbfdb1f1df5728e01b906aba953a"
      },
      "/etc/ssl/certs/XRamp_Global_CA_Root.pem": {
        "length": 1513,
        "offset": 85386441,
        "sha256": "fbe0f62dde93af96d1b8e27b19b2ee200a834880eca805585b66d18d2ea08192"
      },
      "/etc/ssl/certs/a3418fda.0": {
        "length": 765,
        "offset": 85387954,
        "sha256": "7e8b80d078d3dd77d3ed2108dd2b33412c12d7d72cb0965741c70708691776a2"
      },
      "/etc/ssl/certs/a94d09e5.0": {
        "length": 2772,
        "offset": 85388719,
        "sha256": "04846f73d9d0421c60076fd02bad7f0a81a3f11a028d653b0de53290e41dcead"
      },
      "/etc/ssl/certs/aee5f10d.0": {
        "length": 1505,
        "offset": 85391491,
        "sha256": "24e0277c0c028497c6b0abbbf7163ec3ae7b341cadfb0b90bc00c4ad642172cc"
      },
      "/etc/ssl/certs/b0e59380.0": {
        "length": 704,
        "offset": 85392996,
        "sha256": "d1b69887f73444c0fc0a6f22a2fe961c2423275f9c38ba7d50da2a4ba75394f1"
      },
      "/etc/ssl/certs/b1159c4c.0": {
        "length": 1350,
        "offset": 85393700,
        "sha256": "b52fae9cd8dcf49285f0337cd815deca13fedd31f653bf07f61579451517e18c"
      },
      "/etc/ssl/certs/b433981b.0": {
        "length": 2118,
        "offset": 85395050,
        "sha256": "efb2df6e0075fa74e448077e402d171851b2ffe4668a614adc00dcbc75633afd"
      },
      "/etc/ssl/certs/b66938e9.0": {
        "length": 1354,
        "offset": 85397168,
        "sha256": "7ee52fb3a5afacd55a7a2e00f057f7f64776ea0d536036f54c57694961e25179"
      },
      "/etc/ssl/certs/b727005e.0": {
        "length": 1891,
        "offset": 85398522,
        "sha256": "94c88202bf2c13c68b90d124f93f62374f36776b0bfbc110c6d06f829290b580"
      },
      "/etc/ssl/certs/b7a5b843.0": {
        "length": 1269,
        "offset": 85400413,
        "sha256": "b69a59344e58615a691fa9567d55ad6337f09b57647a389242cbf43716575559"
      },
      "/etc/ssl/certs/b81b93f0.0": {
        "length": 904,
        "offset": 85401682,
        "sha256": "8e3f237813d3f3e2f5767bc2a694a7557f84bb79fd60ef1adc25afd0c1fc5ef6"
      },
      "/etc/ssl/certs/bf53fb88.0": {
        "length": 2021,
        "offset": 85402586,
        "sha256": "626d330f6a8944fa4245f02f9795668e25a40b29b4cc5206bee73337b7dcd4d5"
      },
      "/etc/ssl/certs/c01eb047.0": {
        "length": 1891,
        "offset": 85404607,
        "sha256": "de2e7b1bc7a2aed4e5866d3655d1041206c27caf376ee81bfc4012e8225e0e7c"
      },
      "/etc/ssl/certs/c28a8a30.0": {
        "length": 1517,
        "offset": 85406498,
        "sha256": "a00b8aa918457f5e7e58457b5e2f80d640fa77cc290572aaab1ae7b4734a9528"
      },
      "/etc/ssl/certs/ca-certificates.crt": {
        "length": 213777,
        "offset": 85408015,
        "sha256": "dbc50b87d9cb85b488a11efa45488d9d470c7f7dda833345e0c3585968d73f46"
      },
      "/etc/ssl/certs/ca6e4ad9.0": {
        "length": 2033,
        "offset": 85621792,
        "sha256": "d22b235421616835f68d15801d82b44e7c463433f8bbdcc92f9c023fafcb2bf2"
      },
      "/etc/ssl/certs/cbf06781.0": {
        "length": 1367,
        "offset": 85623825,
        "sha256": "500329abac100a953a7396b54b36be57d333022f17401bc948248ea179cf1784"
      },
      "/etc/ssl/certs/cc450945.0": {
        "length": 2122,
        "offset": 85625192,
        "sha256": "1d37341b099afc610bf4feb387096577a0dc61bb8fd09444f1a199a1b1b117e3"
      },
      "/etc/ssl/certs/cd58d51e.0": {
        "length": 1261,
        "offset": 85627314,
        "sha256": "39ad3110b8f84821ca22cfbd995914f2149521d27ce576e743de6a00dc39d9db"
      },
      "/etc/ssl/certs/cd8c0d63.0": {
        "length": 1972,
        "offset": 85628575,
        "sha256": "aa18ea4c9a8441a461bb436a1c90beb994ac841980b8fd62c72de9a62ddf8ae3"
      },
      "/etc/ssl/certs/ce5e74ef.0": {
        "length": 1188,
        "offset": 85630547,
        "sha256": "2c43952ee9e000ff2acc4e2ed0897c0a72ad5fa72c3d934e81741cbd54f05bd1"
      },
      "/etc/ssl/certs/certSIGN_ROOT_CA.pem": {
        "length": 1176,
        "offset": 85631735,
        "sha256": "cf339eae15268aff66148f3bcdf112a7700eafded3edcb3f86c60133b10e03f8"
      },
      "/etc/ssl/certs/certSIGN_Root_CA_G2.pem": {
        "length": 1891,
        "offset": 85632911,
        "sha256": "80eee369aa5b29931209226fcb4b014ba31daa7f630d44a196817c1bb6b334f1"
      },
      "/etc/ssl/certs/d4dae3dd.0": {
        "length": 1537,
        "offset": 85634802,
        "sha256": "f81ceeaf6341513ef391ab3ea3302e8b2fb2c1527752797bba9b20ca22048b3c"
      },
      "/etc/ssl/certs/d52c538d.0": {
        "length": 1931,
        "offset": 85636339,
        "sha256": "fe64d4b3ae749db5ec57b04ed9203c748fff446f57b9665fad988435d89c9e43"
      },
      "/etc/ssl/certs/d6325660.0": {
        "length": 2086,
        "offset": 85638270,
        "sha256": "24b0d4292dacb02efc38542838e378bc35f040dcd21bebfddbc82dc7feb2876d"
      },
      "/etc/ssl/certs/d7e8dc79.0": {
        "length": 2041,
        "offset": 85640356,
        "sha256": "8c4220477ed85355fa380466aa8f559106d8a39fc90d3e0c121749e19444064f"
      },
      "/etc/ssl/certs/d887a5bb.0": {
        "length": 969,
        "offset": 85642397,
        "sha256": "a83c5b6097b03509711c9cd8de59def7ecf99ed72b4076dc33f5b2e35545b3b3"
      },
      "/etc/ssl/certs/dc4d6a89.0": {
        "length": 1972,
        "offset": 85643366,
        "sha256": "5ff8425be71c1805446bf10601ce3cb9619889866766fc9285583ca5a4a7de94"
      },
      "/etc/ssl/certs/dd8e9d41.0": {
        "length": 839,
        "offset": 85645338,
        "sha256": "1914cd2d4cde263315f9e32c7683fc0e1b921919ad12b256d49bf782011c03cc"
      },
      "/etc/ssl/certs/de6d66f3.0": {
        "length": 737,
        "offset": 85646177,
        "sha256": "b0b7961120481e33670315b2f843e643c42f693c7a1010eb9555e06ddc730214"
      },
      "/etc/ssl/certs/e-Szigno_Root_CA_2017.pem": {
        "length": 843,
        "offset": 85646914,
        "sha256": "8c1306d5c64b43ce6c189b8450f27160aaff3f504211ca6819af6035ae1a7d73"
      },
      "/etc/ssl/certs/e113c810.0": {
        "length": 1330,
        "offset": 85647757,
        "sha256": "d1e1969cdbc656bb4c568116fe2d9b4f8b02b170dc20193b86a26c046f4b35a7"
      },
      "/etc/ssl/certs/e18bfb83.0": {
        "length": 1923,
        "offset": 85649087,
        "sha256": "198cfe560c191a800cbe923ceca0a4e4f3d5a0d7ff9316b47998765fdc0897be"
      },
      "/etc/ssl/certs/e35234b1.0": {
        "length": 2053,
        "offset": 85651010,
        "sha256": "e6c62d3f63ba03f4dac458b7dac6c09eb4d71cc3c6621769c3883ed51677c01c"
      },
      "/etc/ssl/certs/e36a6752.0": {
        "length": 1261,
        "offset": 85653063,
        "sha256": "79e9f88ab505186e36f440c88bc37e103e1a9369a0ebe382c4a04bd70b91c027"
      },
      "/etc/ssl/certs/e73d606e.0": {
        "length": 1346,
        "offset": 85654324,
        "sha256": "2dc52d373089ff5173ac392a464746dd066aaa3b7d1b3494a473c96686666fce"
      },
      "/etc/ssl/certs/e868b802.0": {
        "length": 843,
        "offset": 85655670,
        "sha256": "8c1306d5c64b43ce6c189b8450f27160aaff3f504211ca6819af6035ae1a7d73"
      },
      "/etc/ssl/certs/e8de2f56.0": {
        "length": 1915,
        "offset": 85656513,
        "sha256": "8db5b7c8f058c56a8d033c2443d34fdfd3656150eaa73fe63c65161e7063ce99"
      },
      "/etc/ssl/certs/ePKI_Root_Certification_Authority.pem": {
        "length": 2033,
        "offset": 85658428,
        "sha256": "d22b235421616835f68d15801d82b44e7c463433f8bbdcc92f9c023fafcb2bf2"
      },
      "/etc/ssl/certs/ecccd8db.0": {
        "length": 867,
        "offset": 85660461,
        "sha256": "c6dc63e98b3a5e6a595c7d583a9c47c5efb6d316957466fd16c785b423eacf37"
      },
      "/etc/ssl/certs/ed858448.0": {
        "length": 774,
        "offset": 85661328,
        "sha256": "2ce349e2da9df497cc62aca37b009a2c3261ccdbe06a4c4a063f8105da40eb5d"
      },
      "/etc/ssl/certs/ee64a828.0": {
        "length": 1517,
        "offset": 85662102,
        "sha256": "a5ddabd1602ae1c66ce11ad078e734cc473dcb8e9f573037832d8536ae3de90b"
      },
      "/etc/ssl/certs/eed8c118.0": {
        "length": 940,
        "offset": 85663619,
        "sha256": "d69f7b57250536f57ffba92cffe82a8bbcb16e03a9a2607ec967f362ce83f9ce"
      },
      "/etc/ssl/certs/ef954a4e.0": {
        "length": 1923,
        "offset": 85664559,
        "sha256": "1d03b965511ce50d0a0bae1b549ed7048c783cfcba9aa40ea11d355b1889657c"
      },
      "/etc/ssl/certs/emSign_ECC_Root_CA_-_C3.pem": {
        "length": 814,
        "offset": 85666482,
        "sha256": "b1d0ac5a261e857409cc921acb515796538b48847722f0a00ddccbf60bccec81"
      },
      "/etc/ssl/certs/emSign_ECC_Root_CA_-_G3.pem": {
        "length": 859,
        "offset": 85667296,
        "sha256": "36e68e205b53c67c7a013894e0d5c8583063468118d1ce78ecbc2200d1dd185c"
      },
      "/etc/ssl/certs/emSign_Root_CA_-_C1.pem": {
        "length": 1257,
        "offset": 85668155,
        "sha256": "fb98230f8746d60429c20f8ce04254384337b479a77698939f7041d0c0eb4289"
      },
      "/etc/ssl/certs/emSign_Root_CA_-_G1.pem": {
        "length": 1302,
        "offset": 85669412,
        "sha256": "8d390d4c54f6a4a040b04413f1f002192027c66a2a835741f78a152074584a27"
      },
      "/etc/ssl/certs/f081611a.0": {
        "length": 1448,
        "offset": 85670714,
        "sha256": "47f15a52a984ab1f9cd92b6c1849c0465c1b3c9c6837d54e5d2c004fa01b69b7"
      },
      "/etc/ssl/certs/f0c70a8d.0": {
        "length": 956,
        "offset": 85672162,
        "sha256": "662d60a283f416d888ff18831009e2cba95c61377f648beeed91a3dea12ac286"
      },
      "/etc/ssl/certs/f249de83.0": {
        "length": 2090,
        "offset": 85673118,
        "sha256": "0c7ffc481084cad9ccd3402eba9401b0f5abea0917d985e9ce401c8efbad4b04"
      },
      "/etc/ssl/certs/f30dd6ad.0": {
        "length": 948,
        "offset": 85675208,
        "sha256": "08fb40ba4144166f6ae80c7ab60be23e97e5083836d45fa85a33a5d0bfec10f8"
      },
      "/etc/ssl/certs/f3377b1b.0": {
        "length": 1224,
        "offset": 85676156,
        "sha256": "684f2f6ce0a18fcb038d08a495846fbc35b96d99875fef1b24384cf0944a68c3"
      },
      "/etc/ssl/certs/f387163d.0": {
        "length": 1468,
        "offset": 85677380,
        "sha256": "1ad8373ec50073168cb6862a0e119adf2c1065c896adf7eb9695779739b4bb2e"
      },
      "/etc/ssl/certs/f39fc864.0": {
        "length": 1350,
        "offset": 85678848,
        "sha256": "a3e70af2c4b48562b61fe858d9d30f073f2cf2136f2af01ab5a966673e70af4b"
      },
      "/etc/ssl/certs/f51bb24c.0": {
        "length": 2264,
        "offset": 85680198,
        "sha256": "fe3b44c18182e167121a2c645cecc4817441d469dc00633e60fe8476f9e1ad96"
      },
      "/etc/ssl/certs/fa5da96b.0": {
        "length": 1972,
        "offset": 85682462,
        "sha256": "b3bcd05e1b177130f6888fcc1cff4e01cff44ef8e6b0d035f04ad6a71dd0879c"
      },
      "/etc/ssl/certs/fc5a8f99.0": {
        "length": 2094,
        "offset": 85684434,
        "sha256": "8a3dbcb92ab1c6277647fe2ab8536b5c982abbfdb1f1df5728e01b906aba953a"
      },
      "/etc/ssl/certs/fd64f3fc.0": {
        "length": 2037,
        "offset": 85686528,
        "sha256": "8a852f7182753cb0193299c6cb2b4a106b1c38a789217b5eb380d736c5cc0081"
      },
      "/etc/ssl/certs/fe8a2cd8.0": {
        "length": 1257,
        "offset": 85688565,
        "sha256": "cbe8a1eec737c93d1c1cc54e31421f81bf358aa43fbc1ac763d80ce61a17fce0"
      },
      "/etc/ssl/certs/feffd413.0": {
        "length": 769,
        "offset": 85689822,
        "sha256": "5bd16128d0934629c2e1713140a6f97c9828dbb5429ab5797b2573efc71de1a1"
      },
      "/etc/ssl/certs/ff34af3f.0": {
        "length": 1582,
        "offset": 85690591,
        "sha256": "c6904218e180fbfb0ed91d81e892c2dd983c4a3404617cb36aeb3a434c3b9df0"
      },
      "/etc/ssl/certs/vTrus_ECC_Root_CA.pem": {
        "length": 774,
        "offset": 85692173,
        "sha256": "2ce349e2da9df497cc62aca37b009a2c3261ccdbe06a4c4a063f8105da40eb5d"
      },
      "/etc/ssl/certs/vTrus_Root_CA.pem": {
        "length": 1911,
        "offset": 85692947,
        "sha256": "8cc726cf62c554561e89e1237495bea3026b1709ba7153fed3401fcd489b5aaf"
      },
      "/icu/icudt75l.dat": {
        "length": 30729184,
        "offset": 54055633,
        "sha256": "465cd1c736034a68508f0d02dce3fe5d9b696209894847f3b647734241f9dc1d"
      },
      "/usr/share/doc/shiro/php/README.md": {
        "length": 4876,
        "offset": 85695126,
        "sha256": "646836cd1550c34ebc7b1052ac7f84c8b64e52c33af8d1ff8fdaaba06e870dc2"
      }
    },
    "upstream": {
      "readme": {
        "path": "/README.md",
        "volume": "metadata"
      }
    }
  },
  "openssl": {
    "sha256": "ac3a7fa2a57d384fa9e4b30c935a99fa323193cd1b7421bb899dfc2864ec43cc",
    "length": 1642434,
    "atoms": {
      "openssl": {
        "length": 1640537,
        "offset": 1216,
        "sha256": "691c38d0c4bf64a7cddc994fd0f2e368fbb03458a4966b9cecd1b13212feeafd"
      }
    },
    "commands": {
      "openssl": "openssl"
    },
    "resources": {
      "/usr/share/doc/shiro/openssl/README.md": {
        "length": 511,
        "offset": 1641923,
        "sha256": "1c506a2ae5b59ca749e921d0d7b2598ccb5e984d71aa6ad966a77dd6abed88a3"
      }
    },
    "upstream": {
      "description": "OpenSSL is a robust, commercial-grade, and full-featured toolkit for the Transport Layer Security (TLS) and Secure Sockets Layer (SSL) protocols",
      "name": "openssl",
      "readme": {
        "path": "/README.md",
        "volume": "metadata"
      },
      "repository": "https://github.com/wapm-packages/OpenSSL",
      "version": "0.2.0"
    }
  },
  "wabt": {
    "sha256": "28b90a71338d161324ec4187d7afeb08df0eb98181e7e51c83f3f3f9a4cd1522",
    "length": 3420566,
    "atoms": {
      "wabt": {
        "length": 567898,
        "offset": 2837,
        "sha256": "937038e5939e92089c516819098b23a4d1a825a4052ecf3c821569996f9d0028"
      },
      "wasm-interp": {
        "length": 522234,
        "offset": 570735,
        "sha256": "38bf71c47a700e86ac97aabf573ce5933a118cceed206c73cd51fefbfeafa6b6"
      },
      "wasm-strip": {
        "length": 216171,
        "offset": 1092969,
        "sha256": "18fff2a25129ee0f060e84eb02e98c1287114a50e9129f04ef56b06e2bc1496c"
      },
      "wasm-validate": {
        "length": 382968,
        "offset": 1309140,
        "sha256": "cd0446af9f88ca8961d4891384ba0c5e3a264e33d9a8d8661aabcae29e065468"
      },
      "wasm2wat": {
        "length": 441659,
        "offset": 1692108,
        "sha256": "39326529bcddedc358b5da8ab6de9c990bbb5a2e4e186c021e0e1484eae75f4c"
      },
      "wast2json": {
        "length": 655677,
        "offset": 2133767,
        "sha256": "70a43d1ca4fa8ffa23264670e75d74a4e36577b009cc17ba3e62d5bc6d94ada0"
      },
      "wat2wasm": {
        "length": 628364,
        "offset": 2789444,
        "sha256": "70cc8315ee320ae6299ca27a8f7667a48833758e43cd6974201619d635f1992d"
      }
    },
    "commands": {
      "wasm-interp": "wasm-interp",
      "wasm-strip": "wasm-strip",
      "wasm-validate": "wasm-validate",
      "wasm2wat": "wasm2wat",
      "wast2json": "wast2json",
      "wat2wasm": "wat2wasm"
    },
    "resources": {
      "/usr/share/doc/shiro/wabt/README-wapm.md": {
        "length": 1707,
        "offset": 3418118,
        "sha256": "036de1df07f8b6210beef34beaa4afd8516f607975a3fd481731096bd0f41875"
      },
      "/usr/share/doc/shiro/wabt/src/embedding/wabt.wai": {
        "length": 741,
        "offset": 3419825,
        "sha256": "644bc01ae9b53de8d801a90be9f4d21b0ac81cf2149cab7596178f5089114866"
      }
    },
    "upstream": {
      "description": "The WebAssembly Binary Toolkit",
      "name": "wasmer/wabt",
      "readme": {
        "path": "/README-wapm.md",
        "volume": "metadata"
      },
      "repository": "https://github.com/wapm-packages/wabt",
      "version": "1.0.37"
    }
  },
  "brotli": {
    "sha256": "824ad12803f95ed9a963f0e68df7ab3f1b875387f84417390ec73df52b3b2fb0",
    "length": 707459,
    "atoms": {
      "brotli": {
        "length": 705701,
        "offset": 1170,
        "sha256": "aa198bd2b0a7f18bc7e45dfdc07e5a2cb06a994f96632f7c5c39c40c8fe058d0"
      }
    },
    "commands": {
      "brotli": "brotli"
    },
    "resources": {
      "/usr/share/doc/shiro/brotli/README.md": {
        "length": 418,
        "offset": 707041,
        "sha256": "9d4417aec5e44c539099a5028d1d912615b58ba00d13f5bf9ddd2c06fa29a062"
      }
    },
    "upstream": {
      "description": "Brotli is a generic-purpose lossless compression algorithm",
      "homepage": "https://github.com/google/brotli",
      "name": "vshymanskyy/brotli",
      "readme": {
        "path": "/README.md",
        "volume": "metadata"
      },
      "repository": "https://github.com/google/brotli",
      "version": "0.0.1"
    }
  },
  "uuid": {
    "sha256": "bcfcf285510b75a47156a46c8103593a44047acf892114c83344138a0dc0effc",
    "length": 2425666,
    "atoms": {
      "uuid": {
        "length": 2421108,
        "offset": 1152,
        "sha256": "0ce042465a6085c9fa37611a31959bb58a5da4b9756eee9ffe39da318eed7f5c"
      }
    },
    "commands": {
      "uuid": "uuid"
    },
    "resources": {
      "/usr/share/doc/shiro/uuid/README.md": {
        "length": 3236,
        "offset": 2422430,
        "sha256": "26edf006c177aa3cb7f265c977d4df83492371596ee8cabde8c614d51271daae"
      }
    },
    "upstream": {
      "description": "UUID in WebAssembly",
      "homepage": "https://github.com/ken-matsui/uuid-v4-cli#readme",
      "license": "MIT",
      "name": "ken-matsui/uuid",
      "readme": {
        "path": "/README.md",
        "volume": "metadata"
      },
      "repository": "https://github.com/ken-matsui/uuid-v4-cli",
      "version": "0.3.0"
    }
  },
  "qr2text": {
    "sha256": "3741fc7486de905f87bcf8829557260473b0b789c0ec362d9374fd36f4fb62c6",
    "length": 498852,
    "atoms": {
      "qr2text": {
        "length": 497673,
        "offset": 1083,
        "sha256": "ee42716385c8c8b1d9ba916fcf52ff2a258a4152f4e54af2262425d1832671fe"
      }
    },
    "commands": {
      "qr2text": "qr2text"
    },
    "resources": {},
    "upstream": {
      "description": "Render a QR code directly in the terminal",
      "license": "MIT",
      "name": "qr2text",
      "repository": "https://github.com/wapm-packages/qr2text",
      "version": "0.0.1"
    }
  },
  "optipng": {
    "sha256": "ee84c20006bd67d128c67877c9ccaa8ba669a7cbd94ab225fafa241c5552ba8e",
    "length": 230683,
    "atoms": {
      "optipng": {
        "length": 217895,
        "offset": 1215,
        "sha256": "2ab479842cc271088f0a768da0f22600f4d12fe25e97a0b79f8173aa48ce7d02"
      }
    },
    "commands": {
      "optipng": "optipng"
    },
    "resources": {
      "/usr/share/doc/shiro/optipng/README.md": {
        "length": 11403,
        "offset": 219280,
        "sha256": "96822ca19787babce95c7c8afd36a1472a0f31c2ac9b6c8a6ac664d2e1231000"
      }
    },
    "upstream": {
      "description": "OptiPNG is a PNG optimizer that recompresses image files to a smaller size, without losing any information",
      "name": "optipng",
      "readme": {
        "path": "/README.md",
        "volume": "metadata"
      },
      "repository": "https://github.com/wapm-packages/optipng",
      "version": "0.1.2"
    }
  },
  "bc": {
    "sha256": "f2da8c5f7a05fbb76a90f745835abf343f88c908873f99953972ba855960d8ca",
    "length": 360751,
    "atoms": {
      "bc": {
        "offset": 0,
        "length": 360751,
        "sha256": "f2da8c5f7a05fbb76a90f745835abf343f88c908873f99953972ba855960d8ca"
      }
    },
    "commands": {
      "bc": "bc"
    },
    "resources": {},
    "upstream": {
      "name": "GNU bc / dc",
      "version": "1.07.1",
      "repository": "https://www.gnu.org/software/bc/",
      "source": "https://ftp.gnu.org/gnu/bc/bc-1.07.1.tar.gz",
      "source_sha256": "62adfca89b0a1c0164c2cdca59ca210c1d44c3ffc46daf9931cf4942664cb02a",
      "license": "GPL-3.0-or-later",
      "compiler": "wasi-sdk 27.0",
      "target": "wasm32-wasip1",
      "cwd": "scripts/wasi-artifacts/sdk-cwd.c",
      "build": "scripts/wasi-artifacts/build-bc.sh",
      "limitations": [
        "No subprocess shell; dc ! commands cannot run a host process",
        "No readline or NLS"
      ]
    }
  },
  "dc": {
    "sha256": "29d781630c8f34cb8d9ead76d9e9a275c0979c622350d565a357f517bf2d2b14",
    "length": 334804,
    "atoms": {
      "dc": {
        "offset": 0,
        "length": 334804,
        "sha256": "29d781630c8f34cb8d9ead76d9e9a275c0979c622350d565a357f517bf2d2b14"
      }
    },
    "commands": {
      "dc": "dc"
    },
    "resources": {},
    "upstream": {
      "name": "GNU bc / dc",
      "version": "1.07.1",
      "repository": "https://www.gnu.org/software/bc/",
      "source": "https://ftp.gnu.org/gnu/bc/bc-1.07.1.tar.gz",
      "source_sha256": "62adfca89b0a1c0164c2cdca59ca210c1d44c3ffc46daf9931cf4942664cb02a",
      "license": "GPL-3.0-or-later",
      "compiler": "wasi-sdk 27.0",
      "target": "wasm32-wasip1",
      "cwd": "scripts/wasi-artifacts/sdk-cwd.c",
      "build": "scripts/wasi-artifacts/build-bc.sh",
      "limitations": [
        "No subprocess shell; dc ! commands cannot run a host process",
        "No readline or NLS"
      ]
    }
  },
  "cal": {
    "sha256": "36bb2a5e5fc4c3a4e7c59ced38a30799e32d57d6440faeb311880fce791507c0",
    "length": 389040,
    "atoms": {
      "cal": {
        "offset": 0,
        "length": 389040,
        "sha256": "36bb2a5e5fc4c3a4e7c59ced38a30799e32d57d6440faeb311880fce791507c0"
      }
    },
    "commands": {
      "cal": "cal"
    },
    "resources": {},
    "upstream": {
      "name": "bsdmainutils/ncal",
      "version": "12.1.7+nmu3ubuntu2",
      "source_url": "https://archive.ubuntu.com/ubuntu/pool/universe/b/bsdmainutils/bsdmainutils_12.1.7+nmu3ubuntu2.tar.xz",
      "source_sha256": "10d090d8dbefbc48ee3053ac0b12f6242b33af360b34545acb83f3915f93f366",
      "compiler": "wasi-sdk 27.0",
      "target": "wasm32-wasip1",
      "build": "scripts/wasi-artifacts/build-cal.sh",
      "license": "BSD-2-Clause-FreeBSD",
      "patches": [
        "remove BSD-only identification include",
        "omit termcap calls: runtime has no terminal",
        "derive day-first date preference from standard D_FMT"
      ],
      "limitations": [
        "noninteractive output only",
        "wasi-libc C/C.UTF-8 locale support"
      ],
      "cwd": "scripts/wasi-artifacts/sdk-cwd.c"
    }
  },
  "hexdump": {
    "sha256": "c1d430c483e6b256adf55398ae5bbe24dc920f5a3f87660ed76733f325453381",
    "length": 426420,
    "atoms": {
      "hexdump": {
        "offset": 0,
        "length": 426420,
        "sha256": "c1d430c483e6b256adf55398ae5bbe24dc920f5a3f87660ed76733f325453381"
      }
    },
    "commands": {
      "hexdump": "hexdump"
    },
    "resources": {},
    "upstream": {
      "name": "util-linux",
      "version": "2.37.2-fg1",
      "repository": "https://github.com/util-linux/util-linux",
      "source_url": "https://www.kernel.org/pub/linux/utils/util-linux/v2.37/util-linux-2.37.2.tar.xz",
      "source_sha256": "6a0764c1aae7fb607ef8a6dd2c0f6c47d5e5fd27aa08820abaad9ec14e28e9d9",
      "getopt_source_url": "https://ftp.gnu.org/gnu/sed/sed-4.8.tar.xz",
      "getopt_source_sha256": "f79b0cfea71b37a8eeec8490db6c5f7ae7719c35587f21edb0617f370eeff633",
      "compiler": "wasi-sdk 27.0",
      "target": "wasm32-wasip1 + wasix_32v1.fd_dup",
      "license": "GPL-3.0-or-later; BSD and LGPL component notices retained",
      "build": "scripts/wasi-artifacts/build-util-linux.sh",
      "corresponding_source": "/shiro/wasm/util-linux-2.37.2-fg1-source.tar.xz",
      "corresponding_source_sha256": "f82d42a783e315e251d50e59ec17f2600d8ce6ca90f3791e1d839aedb5443a8a",
      "port_files_sha256": {
        "build-util-linux.sh": "6f46e0d2ea689f91755817e7994fe3c72ca201c007266f42fb217e284379b5c3",
        "sdk-cwd.c": "ec161231ebca96af16a012487b79af206f2b7c5ba0ff8cc4cc47262e24a1b970",
        "bsd-errors.c": "3730be43841e1def5708c7f772b5d0d290f528fb20ba0b232431678354a1e076",
        "gnu-errors.c": "e8e2e424b698c3c3a5e150e6ee6fb034d4e6c38f168bab229d958068e75b2128",
        "util-linux-stdio.c": "a54029af5f9368839f81f3c703beaa538297ac53b869ce4d1b7e326299370b96",
        "util-linux-stdio.h": "1e0df0b50a6d7a2c9e1bee46ad87b6a5e24c8b0104a8ee4741e3e2716cf54667",
        "libc-diagnostics.json": "30915a28af7924d3b56a7638f9b940a34958f19964df3f4fe3d45b6fd7a24fec",
        "sdk27-licenses.json": "7495cf590519f267a16f6076c861ef670e43b9c839dfb4ee6094f0906ce33805"
      },
      "limitations": [
        "non-TTY command execution",
        "C locale diagnostics",
        "no kernel identity or setuid capabilities",
        "full security/resource quota acceptance remains open"
      ],
      "wasi_libc_commit": "3f7eb4c7d6ede4dde3c4bffa6ed14e8d656fe93f",
      "licenses_sha256": {
        "public/shiro/wasm/WASI-LIBC-LICENSE": "2711a8b5a5cdfef0e639f96c1aca12ae23d7d64a02d0507f1bdf14d2b27bbc3a",
        "public/shiro/wasm/WASI-LIBC-LICENSE-APACHE-LLVM": "268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5",
        "public/shiro/wasm/WASI-LIBC-LICENSE-APACHE": "a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2",
        "public/shiro/wasm/WASI-LIBC-LICENSE-MIT": "23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3",
        "public/shiro/wasm/WASI-LIBC-libc-bottom-half-cloudlibc-LICENSE": "c8b789cf5a746611e6300a0cc7750dbf92b61912a709d04e639245f7290656d0",
        "public/shiro/wasm/WASI-LIBC-libc-top-half-musl-COPYRIGHT": "f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af",
        "public/shiro/wasm/WASI-LIBC-fts-musl-fts-COPYING": "55af87e4017668f54467a3380e7ebbac5e672d8c763bfe95e6fc882a6fdc4046"
      }
    }
  },
  "rev": {
    "sha256": "f16932cc2f3946a997e6d725042dd8a4bf1da4a7c915632d1c9156f8dfbb4bf5",
    "length": 303780,
    "atoms": {
      "rev": {
        "offset": 0,
        "length": 303780,
        "sha256": "f16932cc2f3946a997e6d725042dd8a4bf1da4a7c915632d1c9156f8dfbb4bf5"
      }
    },
    "commands": {
      "rev": "rev"
    },
    "resources": {},
    "upstream": {
      "name": "util-linux",
      "version": "2.37.2-fg1",
      "repository": "https://github.com/util-linux/util-linux",
      "source_url": "https://www.kernel.org/pub/linux/utils/util-linux/v2.37/util-linux-2.37.2.tar.xz",
      "source_sha256": "6a0764c1aae7fb607ef8a6dd2c0f6c47d5e5fd27aa08820abaad9ec14e28e9d9",
      "getopt_source_url": "https://ftp.gnu.org/gnu/sed/sed-4.8.tar.xz",
      "getopt_source_sha256": "f79b0cfea71b37a8eeec8490db6c5f7ae7719c35587f21edb0617f370eeff633",
      "compiler": "wasi-sdk 27.0",
      "target": "wasm32-wasip1 + wasix_32v1.fd_dup",
      "license": "GPL-3.0-or-later; BSD and LGPL component notices retained",
      "build": "scripts/wasi-artifacts/build-util-linux.sh",
      "corresponding_source": "/shiro/wasm/util-linux-2.37.2-fg1-source.tar.xz",
      "corresponding_source_sha256": "f82d42a783e315e251d50e59ec17f2600d8ce6ca90f3791e1d839aedb5443a8a",
      "port_files_sha256": {
        "build-util-linux.sh": "6f46e0d2ea689f91755817e7994fe3c72ca201c007266f42fb217e284379b5c3",
        "sdk-cwd.c": "ec161231ebca96af16a012487b79af206f2b7c5ba0ff8cc4cc47262e24a1b970",
        "bsd-errors.c": "3730be43841e1def5708c7f772b5d0d290f528fb20ba0b232431678354a1e076",
        "gnu-errors.c": "e8e2e424b698c3c3a5e150e6ee6fb034d4e6c38f168bab229d958068e75b2128",
        "util-linux-stdio.c": "a54029af5f9368839f81f3c703beaa538297ac53b869ce4d1b7e326299370b96",
        "util-linux-stdio.h": "1e0df0b50a6d7a2c9e1bee46ad87b6a5e24c8b0104a8ee4741e3e2716cf54667",
        "libc-diagnostics.json": "30915a28af7924d3b56a7638f9b940a34958f19964df3f4fe3d45b6fd7a24fec",
        "sdk27-licenses.json": "7495cf590519f267a16f6076c861ef670e43b9c839dfb4ee6094f0906ce33805"
      },
      "limitations": [
        "non-TTY command execution",
        "C locale diagnostics",
        "no kernel identity or setuid capabilities",
        "full security/resource quota acceptance remains open"
      ],
      "wasi_libc_commit": "3f7eb4c7d6ede4dde3c4bffa6ed14e8d656fe93f",
      "licenses_sha256": {
        "public/shiro/wasm/WASI-LIBC-LICENSE": "2711a8b5a5cdfef0e639f96c1aca12ae23d7d64a02d0507f1bdf14d2b27bbc3a",
        "public/shiro/wasm/WASI-LIBC-LICENSE-APACHE-LLVM": "268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5",
        "public/shiro/wasm/WASI-LIBC-LICENSE-APACHE": "a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2",
        "public/shiro/wasm/WASI-LIBC-LICENSE-MIT": "23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3",
        "public/shiro/wasm/WASI-LIBC-libc-bottom-half-cloudlibc-LICENSE": "c8b789cf5a746611e6300a0cc7750dbf92b61912a709d04e639245f7290656d0",
        "public/shiro/wasm/WASI-LIBC-libc-top-half-musl-COPYRIGHT": "f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af",
        "public/shiro/wasm/WASI-LIBC-fts-musl-fts-COPYING": "55af87e4017668f54467a3380e7ebbac5e672d8c763bfe95e6fc882a6fdc4046"
      }
    }
  }
};

// Emscripten loader code is executable too; verify it before importing.
export const SEVENZIP_ASSET_PINS = {
  "7zz.es6.js": {
    "url": "https://cdn.jsdelivr.net/npm/7z-wasm@1.2.0/7zz.es6.js",
    "length": 82918,
    "sha256": "f2010cb8d734cac7290a2b27278b30f2bbcd0d354f900173b4cad6b7d46a767a"
  },
  "7zz.umd.js": {
    "url": "https://cdn.jsdelivr.net/npm/7z-wasm@1.2.0/7zz.umd.js",
    "length": 83122,
    "sha256": "163ddd968550dccf3da53afd0384f03868b33e5cb146a76080e6368721a75d08"
  },
  "7zz.wasm": {
    "url": "https://cdn.jsdelivr.net/npm/7z-wasm@1.2.0/7zz.wasm",
    "length": 1651931,
    "sha256": "e16c6997e2eaa89575c0dd1f305074be629c3f4d87246244d37fd19debc8a285"
  }
};
