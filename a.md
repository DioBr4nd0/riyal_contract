# Dimensions & Deterministic 3D Identity Vector — Standalone Spec (Markdown)

> **Scope.** This document contains only the **embedding dimension sizing (proof/derivations)** and the **deterministic 3D identity vector** specification. It omits RGB/Depth branches, fusion, trunks/heads, and training losses, except where needed to motivate design choices. The structure and constants align with your original “Machine Learning — Notes” and incorporate the corrections from the “problems” memo. :contentReference[oaicite:0]{index=0} :contentReference[oaicite:1]{index=1}

---

## Part A — Embedding Dimension Sizing (Derivations + Numbers)

### A.1 Notation & setting
- Final embeddings are unit vectors \(z \in \mathbb{R}^n\) with \(\|z\|_2 = 1\), so they live on the unit sphere \(S^{n-1}\). Cosine similarity is the dot product:
  \[
  \cos(z_i, z_j) \;=\; z_i^\top z_j,\qquad \angle(z_i,z_j) \;=\; \arccos(z_i^\top z_j).
  \]
- We want to support up to \(M=5\times10^{10}\) identities. We size \(n\) using a **design margin** \(\delta\) that is **not** a runtime threshold; it is a conservative angle used for capacity calculations. Your spec adopts \(\delta = 13.18^\circ \approx 0.230034\ \text{rad}\) with \(\cos\delta \approx 0.9737\). :contentReference[oaicite:2]{index=2}

### A.2 Spherical caps: exact measure and high‑dim approximation
- A spherical cap of angular radius \(\varphi\) has **exact** surface‑area fraction:
  \[
  \mu(\text{cap}(\varphi)) \;=\; I_{\sin^2\!\varphi}\!\Big(\frac{n-1}{2}, \frac{1}{2}\Big),
  \]
  where \(I_x(a,b)\) is the **regularized incomplete beta function**. :contentReference[oaicite:3]{index=3}
- For small \(\varphi\) and large \(n\), a standard **high‑dimension** approximation is
  \[
  \mu(\text{cap}(\varphi)) \;\approx\; \exp\!\Big(-\tfrac{(n-1)\,\varphi^2}{2}\Big).
  \] 
  This captures the sphere’s concentration phenomenon and yields clean, closed‑form proxies. :contentReference[oaicite:4]{index=4}

### A.3 Two sizing proxies (cap‑packing vs. typical‑case)
We consider two classical (complementary) heuristics: :contentReference[oaicite:5]{index=5}

**(i) Cap‑packing (worst‑case)** — require **all pairs** of \(M\) points to be \(\ge \delta\) apart. A standard bound is
\[
M \cdot \mu(\text{cap}(\delta/2)) \;\le\; 1
\;\Rightarrow\;
\ln M \;\lesssim\; \frac{(n-1)\delta^2}{8}
\;\Rightarrow\;
n_{\min,\text{cap}} \;\approx\; \frac{8\ln M}{\delta^2}.
\]

**(ii) Typical‑case / random‑coding (FAR‑driven)** — require the probability that **a random non‑match** falls within \(\delta\) to be tiny. A common surrogate is
\[
\ln M \;\lesssim\; \frac{n\,\delta^2}{2}
\;\Rightarrow\;
n_{\min,\text{typ}} \;\approx\; \frac{2\ln M}{\delta^2}.
\]

> **Important caveat (made explicit).** Both proxies implicitly assume **uniform i.i.d.** points on \(S^{n-1}\). Real embeddings are **anisotropic and correlated** (manifold‑structured), so uniform‑sphere laws **overestimate** usable capacity and **underestimate** collisions. We correct for this in §A.5 by (i) replacing \(n\) with an **effective dimensionality** \(n_\text{eff}\) and (ii) applying an empirical **safety factor** \(\gamma\) calibrated on tail FAR at large \(N\). :contentReference[oaicite:6]{index=6}

### A.4 Numeric instantiation (your design constants)
Let
\[
M = 5\times 10^{10},\qquad
\delta = 13.18^\circ = 0.2300343954\ \text{rad},\qquad
\delta^2 \approx 0.0529158231,\qquad
\ln M = \ln(5\times10^{10}) \approx 24.6352888.
\] 
Then
- **Typical‑case bound**:
\[
n_{\min,\text{typ}} \;\approx\; \frac{2\ln M}{\delta^2}
\;=\; \frac{2\cdot 24.6352888}{0.0529158231}
\;\approx\; \boxed{931.11}.
\]
- **Cap‑packing bound**:
\[
n_{\min,\text{cap}} \;\approx\; \frac{8\ln M}{\delta^2}
\;=\; \frac{8\cdot 24.6352888}{0.0529158231}
\;\approx\; \boxed{3724.45}.
\]
These are the same figures presented in your spec. :contentReference[oaicite:7]{index=7}

### A.5 Independence correction: \(n_\text{eff}\) and \(\gamma\)
- **Effective dimensionality** \(n_\text{eff}\) from the **participation ratio** of the (whitened) impostor covariance spectrum \(\{\lambda_i\}\):
  \[
  n_\text{eff} \;=\; \frac{\big(\sum_i \lambda_i\big)^2}{\sum_i \lambda_i^2}.
  \]
  Intuition: if the energy is concentrated in fewer directions, \(n_\text{eff} < n\). :contentReference[oaicite:8]{index=8}
- **Safety factor** \(\gamma\): choose \(\gamma\) so that tail **FAR/FPIR** measured on large‑\(N\) searches satisfies requirements; then set
  \[
  n_\text{final} \;=\; \Big\lceil \gamma \cdot n_{\min,\text{typ}}\big(n\!\to\!n_\text{eff}\big)\Big\rceil.
  \]
  Your spec’s head dimension choice of **3072** corresponds to \(\gamma \approx \tfrac{3072}{931.11}\approx \mathbf{3.30}\), giving generous headroom for non‑idealities while aligning with ANN indexing later. :contentReference[oaicite:9]{index=9}

> **Why this matters.** The “uniform sphere” laws give the elegant \(M \propto e^{n\delta^2/2}\) scaling. In practice, correlation **slows** that growth. Using \(n_\text{eff}\) + \(\gamma\) bakes the gap between theory and reality into the dimension choice rather than assuming it away. :contentReference[oaicite:10]{index=10}

### A.6 1:N searches: thresholds scale with \(N\)
Let \(S\) be the **impostor** cosine score. For a gallery of size \(N\),
\[
\Pr\big(\max_{1\le i\le N} S_i \ge t\big) \;=\; 1 - \big(1 - \Pr(S \ge t)\big)^N \;\approx\; N\,\Pr(S\ge t)\quad(\text{small tails}).
\]
Pick threshold \(t\) to meet FPIR at the intended \(N\). This is the operational link between **dimension sizing** and **decision thresholds** at scale; it also informs the choice of \(\gamma\). :contentReference[oaicite:11]{index=11}

### A.7 Decision & cheat‑sheet
- **Design margin:** \(\delta=13.18^\circ\) (capacity sizing only).  
- **Bounds:** \(n_{\min,\text{typ}}\approx 931\), \(n_{\min,\text{cap}}\approx 3724\).  
- **Independence correction:** use \(n_\text{eff}\) + \(\gamma\) (empirical).  
- **Final head (context):** **3072D** in your full system (outside this doc’s scope) corresponds to \(\gamma\approx 3.30\) and is consistent with the spec. :contentReference[oaicite:12]{index=12} :contentReference[oaicite:13]{index=13}

---

## Part B — Deterministic 3D Identity Vector \(u_{\mathbf{3D}}\in\mathbb{R}^{838}\)

### B.0 Purpose: what 3D gives us (and why it’s here)
- **Robust identity signal** from **intrinsic geometry**—largely invariant to lighting, color, and many expressions.  
- **Complementary** to appearance cues (RGB) and per‑pixel depth: 3D anchors the identity space to **bone‑level** shape and surface structure.  
- **Deterministic & interpretable:** a non‑ML pipeline with explicit QC hooks—ideal for production auditability. These were core motivations in your spec. :contentReference[oaicite:14]{index=14}

### B.1 Inputs & registration
- **Input:** registered facial mesh \(\mathcal{M}=(\mathcal{V},\mathcal{E})\) + **68 landmarks** \(\{p_\ell\}_{\ell=1}^{68}\).  
- **Alignment:** **Rigid ICP** → **non‑rigid ARAP** → **Procrustes** normalization to remove global translation/rotation/scale for between‑subject comparability.  
- **QC gates:** reject/down‑weight scans with high **ICP RMS residual**, high **% holes/degenerate tris**, or large **bilateral landmark‑symmetry** error; map these to the 3D quality \(q_\text{3D}\) via a **monotone** calibrator. :contentReference[oaicite:15]{index=15} :contentReference[oaicite:16]{index=16}

**Rigid ICP (closed‑form sketch).** Given correspondences \(\{x_i\}\leftrightarrow\{y_i\}\), center them, compute \(H=\sum_i x_i y_i^\top\), SVD \(H=USV^\top\), set \(R=VU^\top\) (enforce \(\det R=+1\)), \(t=\bar y - R\bar x\).  
**Non‑rigid ARAP.** Minimize \(\sum_k\sum_{j\in \mathcal{N}(k)} w_{kj}\,\| (x_k-x_j) - R_k(x_k^0-x_j^0)\|^2\) alternating local rotations \(R_k\) and global positions.  
**Procrustes.** Solve \(\min_{s,R,t}\|sRX+t-Y\|_F^2\) with closed‑form \(s,R,t\). (Details as standard.) :contentReference[oaicite:17]{index=17}

### B.2 Mesh conditioning (stability prerequisites)
To stabilize curvature/HKS/geodesic features across sensors/resolutions:
- **Resample** to a fixed vertex budget before geometry.  
- Apply mild **Laplacian smoothing** (adaptive \(\lambda\)); **clip** curvature outliers to robust percentiles.  
- Record conditioning stats and feed into \(q_\text{3D}\). :contentReference[oaicite:18]{index=18}

### B.3 Feature groups (11 families, total 838D)
Each feature group \(g\) yields a vector \(v^{(g)}\in\mathbb{R}^{D_g}\). Dimensions match your spec. :contentReference[oaicite:19]{index=19}

1. **Landmark coordinates — 204D**  
   After Procrustes, stack \(68\) 3D points:
   \[
   \mathbf{f}_{\text{lm}}=\big[p_1^\top,\dots,p_{68}^\top\big]\in\mathbb{R}^{204}.
   \]
   Captures coarse craniofacial scaffold at anatomically stable sites. :contentReference[oaicite:20]{index=20}

2. **Inter‑landmark Euclidean distances — 96D**  
   For a fixed pair set \(\mathcal{P}\) (\(|\mathcal{P}|=96\)), compute
   \[
   d_{ij}=\|p_i-p_j\|_2=\sqrt{(x_i-x_j)^2+(y_i-y_j)^2+(z_i-z_j)^2},\quad (i,j)\in\mathcal{P}.
   \]
   Concatenate to \(\mathbb{R}^{96}\). Robust to expressions; bone‑driven. :contentReference[oaicite:21]{index=21}

3. **Geodesic (surface) distances — 96D**  
   Use the **heat method** on \(\mathcal{M}\) with cotangent Laplacian \(L\) and mass matrix \(M\):  
   \(\;\)(i) \((M+\tau L)u=\delta_i\);\quad (ii) \(\mathbf{X}=-\nabla u/\|\nabla u\|\);\quad (iii) solve \(L\phi=\nabla\cdot \mathbf{X}\);  
   then \(d_{ij}=\phi(p_j)-\phi(p_i)\) for \((i,j)\in\mathcal{P}\). Yields \(\mathbb{R}^{96}\). :contentReference[oaicite:22]{index=22}

4. **Surface normals at rigid sites — 72D**  
   At \(24\) stable sites \(\{r_k\}\), average incident triangle normals to get unit normals \(n_k=(n_x,n_y,n_z)\). Concatenate to \(\mathbb{R}^{72}\). :contentReference[oaicite:23]{index=23}

5. **Local curvatures (two scales) — 90D**  
   Fit a quadratic patch at \(15\) rigid sites and two radii \(r_1=0.05\,d_\text{io}\), \(r_2=0.10\,d_\text{io}\) (inter‑ocular distance \(d_\text{io}\)). From principal curvatures \((\kappa_1,\kappa_2)\) derive
   \[
   K=\kappa_1\kappa_2,\qquad H=\tfrac{1}{2}(\kappa_1+\kappa_2),\qquad 
   S=\frac{2}{\pi}\arctan\!\frac{\kappa_2-\kappa_1}{\kappa_2+\kappa_1}.
   \]
   Concatenate \(15\times 3\times 2=90\) dims. Use smoothing + robust clipping as in §B.2. :contentReference[oaicite:24]{index=24} :contentReference[oaicite:25]{index=25}

6. **Heat Kernel Signature (HKS) — 140D**  
   Discretize the Laplace–Beltrami operator via cotangent Laplacian \(L\) and mass matrix \(M\):
   \[
   L\phi_i=\lambda_i M\phi_i,\qquad 
   L_{ij}=-\tfrac{1}{2}(\cot\alpha_{ij}+\cot\beta_{ij}),\quad L_{ii}=-\sum_{j\neq i}L_{ij},\quad M=\mathrm{diag}(A_i/3).
   \]
   The HKS at vertex \(x\) and time \(t\) is
   \[
   \operatorname{HKS}(x,t)=\sum_{i=1}^{\infty}e^{-\lambda_i t}\,\phi_i(x)^2.
   \]
   Sample \(t\) on a geometric schedule (e.g., 16 scales) at 8 sites + 12 global stats \(\Rightarrow 140\) dims. :contentReference[oaicite:26]{index=26}

7. **Laplace–Beltrami spectrum (“ShapeDNA”) — 40D**  
   Take first 40 **non‑zero** eigenvalues \(\{\lambda_1,\dots,\lambda_{40}\}\); optionally use log‑domain/area normalization. \(\in\mathbb{R}^{40}\). :contentReference[oaicite:27]{index=27}

8. **Mesh topology statistics — 24D**  
   Deterministic QC features: holes%, boundary length, degenerate‑tri ratio, valence histogram moments, etc. Also feeds \(q_\text{3D}\). \(\in\mathbb{R}^{24}\). :contentReference[oaicite:28]{index=28}

9. **Zernike 3D moments — 64D**  
   Volume moments on the unit ball:
   \[
   Z_{nlm}=\int_V f(r,\theta,\phi)\,R_{nl}(r)\,Y_l^{m}(\theta,\phi)\;r^2\sin\theta\,dr\,d\theta\,d\phi.
   \]
   Use a fixed set of \(64\) \((n,l,m)\) indices; take magnitudes (and optionally normalized phases). \(\in\mathbb{R}^{64}\). :contentReference[oaicite:29]{index=29}

10. **Persistent homology summary — 12D**  
    Build an alpha/VR filtration; for homology groups \(H_k\) with diagrams \(\mathcal{D}_k=\{(b_i,d_i)\}\), summarize by 4 stats (e.g., mean/max persistence, counts above \(\tau\)) for \(k=0,1,2\) \(\Rightarrow 12\) dims. Global, stable cues (e.g., symmetric voids/orbits). :contentReference[oaicite:30]{index=30}

> **Dimension check:** \(204 + 96 + 96 + 72 + 90 + 140 + 40 + 24 + 64 + 12 = \mathbf{838}\) dims (Core‑838), matching your spec. :contentReference[oaicite:31]{index=31}

### B.4 Per‑group normalization & **quality‑aware** weighting (corrected)
For each group \(g\) with raw vector \(v^{(g)}\in\mathbb{R}^{D_g}\):
1. **Robust standardization** (median/MAD) \(\rightarrow\) **PCA‑whiten** \(\rightarrow\) **L2‑normalize**: \(\hat v^{(g)}=v^{(g)}/\|v^{(g)}\|_2\).  
2. Compute deterministic **quality** \(q_g\in[0,1]\) from QC metrics (registration health, holes%, curvature/HKS stability, landmark symmetry,…). **Calibrate** via monotone piecewise‑linear maps; **z‑score per dataset** (mean \(0.5\), std \(0.15\)), then clamp to \([0,1]\). :contentReference[oaicite:32]{index=32}  
3. Convert qualities to **softmax weights** with temperature \(\tau\) (fixed or annealed):
   \[
   w_g \;=\; \frac{\exp(q_g/\tau)}{\sum_j \exp(q_j/\tau)}.
   \]
4. **Energy‑preserving scaling (fix)**:
   \[
   v^{(g)}_{\text{final}} \;=\; \sqrt{w_g}\,\hat v^{(g)}.
   \]
   Then **concatenate** all \(v^{(g)}_{\text{final}}\) and **L2‑normalize** once to produce
   \[
   u_{\text{3D}} \;=\; \operatorname{L2}\!\Big(\big\Vert_{g} \sqrt{w_g}\,\hat v^{(g)}\Big) \;\in\; \mathbb{R}^{838}.
   \]
   *Why \(\sqrt{w}\)?* The squared norm after concatenation is \(\sum_g w_g\) (since \(\|\hat v^{(g)}\|_2=1\)), so each group contributes **energy share \(w_g\)** independent of \(D_g\). This **replaces** the earlier \(D_g\cdot w_g\) rule that over‑weighted large groups. :contentReference[oaicite:33]{index=33} :contentReference[oaicite:34]{index=34}

**Temperature choice.** If you train a downstream learner on \(u_{\text{3D}}\), **anneal** \(\tau:1.0\rightarrow 3.0\) early to avoid single‑group collapse; if you ship \(u_{\text{3D}}\) standalone, pick a vetted fixed \(\tau\) (e.g., 2.0). :contentReference[oaicite:35]{index=35}

### B.5 Practical QC thresholds (operational examples)
- **ICP RMS residual** \(\le \varepsilon_{\text{ICP}}\) (e.g., 1.5 mm).  
- **Holes/degenerate tris** \(\le h_{\max}\) (e.g., 2 %).  
- **Landmark symmetry** \(\le \varepsilon_{\text{sym}}\).  
Failures map to low \(q_\text{3D}\) or skipping 3D entirely for that capture. (Tune numbers on your data.) :contentReference[oaicite:36]{index=36}

### B.6 Mesh‑invariance & sanity checks
- **Repeatability:** reprocess same scan \(\Rightarrow\) \(\cos(u_{\text{3D}},u'_{\text{3D}})\ge 0.99\) under re‑sampling jitter.  
- **Energy check:** \(\|u_{\text{3D}}\|_2=1\) and \(\sum_g \|v^{(g)}_{\text{final}}\|_2^2 \approx 1\).  
- **Resolution invariance:** after resampling/smoothing, curvature/HKS/geodesics stable to small mesh changes. :contentReference[oaicite:37]{index=37}

---

## Summary (what to implement now)
- **Dimension sizing:** keep \(\delta=13.18^\circ\); for theory, quote \(n_{\min,\text{typ}}\approx 931\), \(n_{\min,\text{cap}}\approx 3724\); in practice, measure \(n_\text{eff}\) and keep a calibrated \(\gamma\). :contentReference[oaicite:38]{index=38} :contentReference[oaicite:39]{index=39}  
- **3D vector \(u_{\text{3D}} \in \mathbb{R}^{838}\):** implement the 11 feature families; normalize each group; compute calibrated \(q_g\); **softmax** \(\to\) **\(\sqrt{w_g}\)** scaling \(\to\) concat \(\to\) final **L2**. Enforce registration **QC** and mesh conditioning for stability. :contentReference[oaicite:40]{index=40} :contentReference[oaicite:41]{index=41}
