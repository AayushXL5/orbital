"""SGP4 propagation of CelesTrak OMM element sets (the JSON ``gp.php`` returns)."""

from __future__ import annotations

import numpy as np
from sgp4 import omm
from sgp4.api import Satrec

from . import astro


class SgpObject:
    """One catalogued object, propagated to Earth-fixed positions."""

    def __init__(self, record: dict):
        self.record = record
        self.norad = int(record["NORAD_CAT_ID"])
        self.name = str(record["OBJECT_NAME"])
        self.sat = Satrec()
        omm.initialize(self.sat, record)

    @property
    def epoch_unix(self) -> float:
        jd = self.sat.jdsatepoch + self.sat.jdsatepochF
        return (jd - 2440587.5) * 86400.0

    def ecef(self, t) -> np.ndarray:
        """Positions (N, 3) in km; NaN rows where SGP4 reports an error."""
        t = np.atleast_1d(np.asarray(t, dtype=float))
        jd = astro.unix_to_jd(t)
        whole = np.floor(jd)
        err, r, _ = self.sat.sgp4_array(whole, jd - whole)
        r = np.where((err == 0)[:, None], r, np.nan)
        return astro.inertial_to_ecef(r, t)


def index_by_norad(records) -> dict[int, dict]:
    return {int(r["NORAD_CAT_ID"]): r for r in records}
