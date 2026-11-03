"""Reviewed source closure for the explicit frontend shared-account release.

Literal pins bind the already reviewed account implementation and existing NVIDIA
presentation. A fresh installed main source and retained provider baseline are
still required. No receipt here is authenticated product acceptance.
"""

PREFIX = "onesa-company-portal-frontend/"
PROFILE = "frontend-identity-v1"
# Pin changes require source review; candidate/configuration cannot supply them.
PINS = {
    "onesa-company-portal-frontend/Dockerfile": "e13d6a1e450723a6d8d6aa64c81504f7aebb4983d3fec01016e88ec6257c7f29",
    "onesa-company-portal-frontend/package-lock.json": "a14df9606964f633c89d4237cb99b182767f6dbd47adfde92835f2b0d96bd4f1",
    "onesa-company-portal-frontend/package.json": "2c55384c49e7a35743ca807f21dd2de042e907148cc42e16c5e244c59a764c81",
    "onesa-company-portal-frontend/public/brand/icons/v1/onesa-robot.svg": "35fb7e0ac799a345ef567d230ae9e6f07f95f470499af7f4c2e536c57beee771",
    "onesa-company-portal-frontend/public/brand/icons/v1/sources.json": "20a2216e9f4b6f0fcb3e67a1e5fd28757435de7d5a19c0a02eb4481504367179",
    "onesa-company-portal-frontend/public/brand/sources.json": "feacf92edbd620e3c86af5546a5eb7f0df6423af389eb568f1b29735cd3c5e8c",
    "onesa-company-portal-frontend/public/images/drone-cargo-1280.webp": "a6898dc95fc2240e1d41854940788378a7c74b54e21651fda472431b7c07e485",
    "onesa-company-portal-frontend/public/images/drone-cargo-640.webp": "00f62b1be063d1c2af12ec836cb0d7cc819740fb2cf067887c9730b85497c70d",
    "onesa-company-portal-frontend/public/images/drone-flight-1280.webp": "521126466c5db49d1cf3f0ca4cf4e13ebf27982552d3b4b513746db152c0752c",
    "onesa-company-portal-frontend/public/images/drone-flight-640.webp": "421a20754aa84e538f98c08c35324e11f4a08286b33d456a52270f1bda3eafd7",
    "onesa-company-portal-frontend/public/licenses/three.txt": "8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc",
    "onesa-company-portal-frontend/public/media/onesa-drone-concept.mp4": "6b3b5349d82c56170d9c01e59d5761fbd9958eb7451ec51b25783b98ff73ab78",
    "onesa-company-portal-frontend/public/models/nvidia/manifest.json": "f6049c874e1e3f9b5860ca1bf6d5bad22b5176f7282c868253225d80bff94704",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-mobile-cart/LICENSE.txt": "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-mobile-cart/SOURCE.json": "407523d1c8148e389a4ba3f7222284b02f03dc4bfc9d0e3914b8f46672d425ca",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-mobile-cart/compact.1c37d2744f64601c.glb": "1c37d2744f64601cfa948712dacd788d82c2552233cd368bdc6c918024cdb650",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-mobile-cart/preview.png": "ac0ddd7a8e55b0aef5202695f6fcc9f04e175a6014856bd0428c1d6427a7b548",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-storage-rack/LICENSE.txt": "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-storage-rack/SOURCE.json": "4f904098dc31c2344123ee691d956e7812d5512175546fb8dc1fbe6e3e61d547",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-storage-rack/compact.f62735d8355b5244.glb": "f62735d8355b524467301bdecce77c31b84a303b2d9c31f457dcbff27e9d3e2e",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-storage-rack/preview.png": "e9fbeb5f7703672c038873b483d3a27425afb63128aae0037be9a7c4cdbc7f2b",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-transfer-conveyor/LICENSE.txt": "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-transfer-conveyor/SOURCE.json": "fba81e42e2156c0c6359b689685e4161d0fcd6891517853131bda7971011d4be",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-transfer-conveyor/compact.3f73d759f3f6f233.glb": "3f73d759f3f6f233d5b3196951bf1ade77e163c14576bccdceddebe9e3ebe0f0",
    "onesa-company-portal-frontend/public/models/nvidia/nvidia-transfer-conveyor/preview.png": "920b611de2d96aac5af92e80f2352eda64417abd4a940ac44314de8e8857489a",
    "onesa-company-portal-frontend/scripts/public-shell-ready.mjs": "bd84fdafa98f8f0e59c7955475c58b75d21ad2eef3378a7a80244fde4f12e4c5",
    "onesa-company-portal-frontend/scripts/test-drone-product.mjs": "3bea2bb2b51e6747df223101970218c080b10fcc3c4d1ac719a61cc164a40d3f",
    "onesa-company-portal-frontend/scripts/test-nvidia-library.mjs": "fd9b0f8d669554036ba18460d412eb057b45fa4ce99537e9c1d94cbb717da60b",
    "onesa-company-portal-frontend/scripts/test-onesa-account.mjs": "1de0075eded92a1f7e7cd1e0c92155dc40d6a9b5de19b7a80210af70c3d4793e",
    "onesa-company-portal-frontend/scripts/test-public-loading.mjs": "4a6f3f0f4d0dbdb9f24661152d48a555f078907886cd936d8fc4d1fc8b48fbad",
    "onesa-company-portal-frontend/scripts/validate-nvidia-assets.mjs": "41cc44c7be6fc08e00e85e268742e1740bab1538d3e4d6b86674b4784dda0545",
    "onesa-company-portal-frontend/security/minimatch-callable/README.md": "017d22b9e2057a92eaea7fe84a7d683789b75aa00f3159d8dcb6f688fc5c0ab0",
    "onesa-company-portal-frontend/security/minimatch-callable/UPSTREAM.json": "a905c16f12dd5291d69aa55053dbe1a18e8fd736a41907d51056a911cdf261d4",
    "onesa-company-portal-frontend/security/minimatch-callable/UPSTREAM_LICENSE.md": "2c7c5d22ed5a8ee968c64757710979afcd77438c48b4a265b94e615babd8a901",
    "onesa-company-portal-frontend/security/minimatch-callable/index.cjs": "ca8326bacd689cb4b56c67fa5f6cf3334dfd21a1e0475ec5fca5171e071eb2df",
    "onesa-company-portal-frontend/security/minimatch-callable/package.json": "b8d5cc65cd6227f7ef09701208427899bab96a01da0d86251c2fd71e815e045a",
    "onesa-company-portal-frontend/src/app/[locale]/products/onesa-ai-drone/page.tsx": "e892bf374f6092c91d0ad899979588f2dfb02fb4628587c56625ad25e921770b",
    "onesa-company-portal-frontend/src/app/[locale]/products/onesa-drone/page.tsx": "622a7f147d911932b26a786a5a19fb032e669e671074d88246bb1d237cc7c150",
    "onesa-company-portal-frontend/src/app/access/register/page.tsx": "fe8918cfa167c6efd48e006f680c63c73fdbe25f2315780b79f648d36774169c",
    "onesa-company-portal-frontend/src/app/account/confirm/page.tsx": "7a5d4935e7c1e36b643f72acc1ea0d3f9e47708e5ce14b2e2536e70a86d8fa21",
    "onesa-company-portal-frontend/src/app/account/layout.tsx": "6d3d52502ce5744949ffb0f5b77cacd97b97ac61653bb507ca5df7ba8e046c42",
    "onesa-company-portal-frontend/src/app/account/page.tsx": "5a8e96097730cc9ac1495c85e65ac7cf35d48d36cbbebaca38ab5811ae63ed58",
    "onesa-company-portal-frontend/src/app/account/register/page.tsx": "cb3486c1924d1809bdef9ca25940342ad54ad815ce1f9ad3e90691d9084a6787",
    "onesa-company-portal-frontend/src/app/account/security/page.tsx": "665df823dc94eb83a0b66874ff60250476657c247890893c1cf709bc549f733e",
    "onesa-company-portal-frontend/src/app/account/setup-authenticator/page.tsx": "6ae0f6a931504c3c9f3a8d10284e14f57e29d448d5c0638c66cbed0881a5a1ed",
    "onesa-company-portal-frontend/src/app/account/sign-in/[uid]/page.tsx": "487659424b193ee47164c7c8e9732d63da685db1d2fa309f6a79c55b0b10d5f4",
    "onesa-company-portal-frontend/src/app/admin/page.tsx": "163d7517e01aee14108a335aaf1594fc4d140ddff649966621d75130543fcb1f",
    "onesa-company-portal-frontend/src/app/api/v1/[...path]/route.ts": "7fbb4b327152af662956b0f2410c204349874ec7bda59bd6ac60f81dbb158794",
    "onesa-company-portal-frontend/src/components/company-story.tsx": "ac4a28450431214817639abab33969e36ce0cc8e12d97c1e5cbfc4e6ec7b92ad",
    "onesa-company-portal-frontend/src/components/drone-film.tsx": "bbb97549ba4c1638f2a34ccd74c23611982c6c19a48ee671a7b57029ef8dc257",
    "onesa-company-portal-frontend/src/components/drone-image.tsx": "c9dce4e33b06b3fd4dabef116aa6d78ebfe07e6f7b11f5e68a6ac799b341d18d",
    "onesa-company-portal-frontend/src/components/drone-product.module.css": "4bac1e38ccf8f481005de7143f1c1a89f21b0a5b49c34c192a348e6cb912beb7",
    "onesa-company-portal-frontend/src/components/drone-product.tsx": "a65f90cc6eed9821a2dcf176c5dcac1684f9943a0066bd432811b94491b3a3cf",
    "onesa-company-portal-frontend/src/components/drone-visual.tsx": "dfa59d76dce833bc1fd2943adacdf1ecf0b7e7488f9b403705730f2444aad1ce",
    "onesa-company-portal-frontend/src/components/home-products.tsx": "ebf6740d96487626839786a2e9655229396367271442ab04adca2006cbbce1bd",
    "onesa-company-portal-frontend/src/components/nvidia-reference-library.module.css": "fdfebecb9a6f457ee1fd584068cb5b3ca5fc2efebffa04edc2b760ed4e1ff850",
    "onesa-company-portal-frontend/src/components/nvidia-reference-library.tsx": "92c4eb64c6ff97542ebf5fe618d2b50a7f4e96f2dff04910698f16e379d9691c",
    "onesa-company-portal-frontend/src/components/nvidia-reference-viewer.ts": "affbb2eddbc6fca2e280aa0ad541a8e5958b692c8a7634d89c92954fa02d9d98",
    "onesa-company-portal-frontend/src/components/product-illustration.tsx": "51dd610ee00b8b06c1296e90a7698681956e2a57245e1b3178652dab988b8dbe",
    "onesa-company-portal-frontend/src/components/product-overview.tsx": "8ccf113f761c363933f64c0d7f611d199eda8849e23a70bba2d6d0c2f8ce615f",
    "onesa-company-portal-frontend/src/components/responsive-link.tsx": "e2153f1590c1e9a310e091e27af6bbbee825041b3dd044b36c5c67327082259a",
    "onesa-company-portal-frontend/src/components/site-footer.tsx": "aee902a898185551b5d7abb3ff511a57b9a84a30ff1e372919d2146366ce284d",
    "onesa-company-portal-frontend/src/config/enquiry-topics.ts": "ae1e84a441a79ebbbb4d225684733e6a2ad9256047f009f69cc9baa68c8ff1dd",
    "onesa-company-portal-frontend/src/config/nvidia-reference-assets.json": "f6049c874e1e3f9b5860ca1bf6d5bad22b5176f7282c868253225d80bff94704",
    "onesa-company-portal-frontend/src/config/onesa-applications.json": "0eeccc055f8d6df8662f0763453932e5d55dd5be9530a45a4cd863962f01e635",
    "onesa-company-portal-frontend/src/config/products.ts": "598d187624bc37f4d754e09b426c229a67b6e9c10b24a8aef24a391c57057ee5",
    "onesa-company-portal-frontend/src/features/access/authenticator-setup.tsx": "dda65bd27cb9ca642ce3020555931f7f11387e05105df5918e4670e011a5cd97",  # gitleaks:allow -- SHA-256 of reviewed public source.
    "onesa-company-portal-frontend/src/features/account/access-manager.tsx": "f3a5974714f2f1a69d3c87421a8e3ac02d71c280eb88b11aa0b7d9d104cac1e0",  # gitleaks:allow -- SHA-256 of reviewed public source.
    "onesa-company-portal-frontend/src/features/account/account.module.css": "d8505f9ea39cb9e505e7c6285c308947d77594c47a167cb709ce6d2880d06ad9",
    "onesa-company-portal-frontend/src/features/account/account.tsx": "35f3c027d623d0e4af04120537f50c70c8d35b99eccde8470c1e61e3443a0679",
    "onesa-company-portal-frontend/src/features/account/api.ts": "a33165e1c49aa2cf2607960728ac4bcb7d333ec011425ab6635f032069e6a32d",  # gitleaks:allow -- SHA-256 of reviewed public source.
    "onesa-company-portal-frontend/src/features/account/security.tsx": "bbdeb339758445978c49ae30345424ee487a45e6003617a35de6e59a1102bf83",
    "onesa-company-portal-frontend/src/features/admin/portal.tsx": "deeb9722ccf7434a2835e24f9e2425ea2fcab7c32a46da9dc0306a7621fdcd6e",
    "onesa-company-portal-frontend/src/lib/api/generated/schema.d.ts": "cc807897d168b53e45f55dab0a497bbaddc1f2d68eb94b98dd1176cd456ed795",
    "onesa-company-portal-frontend/src/lib/company-sitemap.ts": "e949ac09c3c3e851a015db461d2c9fe0d5052c708bf530cd019adf49f2f0a5f8",
    "onesa-company-portal-frontend/src/lib/domains.ts": "9cc261a9580b01ffa7215c4db10b6b8ece118e913e06fa4f3f815f0c77916447",
    "onesa-company-portal-frontend/src/lib/onesa-identity.ts": "51d7eb10a92961e7636c736672e84c810717c0e261b38153752dd4a39800dd59",
    "onesa-company-portal-frontend/src/proxy.ts": "01acb9084f2d2af5610a723896602b1578b83baa59c0fa8e55b0e31add46955f",
    "onesa-company-portal-frontend/tests/product-evidence.spec.ts": "b20e9de5778d825e87c5521c506e243a2c40a67f201776067254a8184915cd36",
    "onesa-company-portal-frontend/unit/dependency-security.test.mjs": "6385e1186038f6f7eb64f40d42793012d6590bf6785011a79f55798e9f356e4b",
    "onesa-company-portal-frontend/unit/nvidia-assets.test.mjs": "81483abd13d83e3ddc348cb084411b0c029861738ddb5a432c80f934c5d40bf3",
    "onesa-company-portal-frontend/unit/onesa-identity.test.ts": "0c136760bc52682184008bee442a1966ac20f907ae9677d32f1082a994ac2ccf",
    "onesa-company-portal-frontend/vendor/onesa-portal-minimatch-callable-1.0.0.tgz": "c532a6f7105c1934d4b0852881a59b981dd68217663debdee1a919a9a9de493c"
}


def reviewed_delta(old, new):
    if not isinstance(old, dict) or not isinstance(new, dict):
        raise ValueError("IDENTITY_FRONTEND_SOURCE_INVENTORY")
    if not all(new.get(name) == checksum for name, checksum in PINS.items()):
        raise ValueError("IDENTITY_FRONTEND_REVIEWED_SOURCE_CHANGED")
    changed = {name for name in old.keys() | new.keys()
               if name.startswith(PREFIX) and old.get(name) != new.get(name)}
    if not changed or not changed <= PINS.keys() or not changed <= new.keys():
        raise ValueError("IDENTITY_FRONTEND_CHANGED_SCOPE")
    return sorted(changed)
