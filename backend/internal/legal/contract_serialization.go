package legal

import (
	"bytes"
	"encoding/json"
	"io"
)

func DecodeLegalCommerceDisclosure(encoded []byte) (LegalCommerceDisclosure, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var disclosure LegalCommerceDisclosure
	if err := decoder.Decode(&disclosure); err != nil {
		return LegalCommerceDisclosure{}, ErrInvalidContractValue
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF || !ValidLegalCommerceDisclosure(disclosure) {
		return LegalCommerceDisclosure{}, ErrInvalidContractValue
	}
	return cloneLegalCommerceDisclosure(disclosure), nil
}

func SerializeContractOffer(offer ContractOfferSnapshot) (string, error) {
	if !ValidContractOfferSnapshot(offer) {
		return "", ErrInvalidContractValue
	}
	encoded, err := marshalJavaScriptJSON(offer)
	if err != nil {
		return "", ErrInvalidContractValue
	}
	return string(encoded), nil
}

func DecodeContractOffer(encoded []byte) (ContractOfferSnapshot, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var offer ContractOfferSnapshot
	if err := decoder.Decode(&offer); err != nil {
		return ContractOfferSnapshot{}, ErrInvalidContractValue
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF || !ValidContractOfferSnapshot(offer) {
		return ContractOfferSnapshot{}, ErrInvalidContractValue
	}
	serialized, err := SerializeContractOffer(offer)
	if err != nil || serialized != string(encoded) {
		return ContractOfferSnapshot{}, ErrInvalidContractValue
	}
	return offer, nil
}

func cloneLegalCommerceDisclosure(value LegalCommerceDisclosure) LegalCommerceDisclosure {
	value.SystemRequirements = append([]string(nil), value.SystemRequirements...)
	return value
}

func cloneContractEvidenceRecord(value ContractEvidenceRecord) ContractEvidenceRecord {
	return value
}
